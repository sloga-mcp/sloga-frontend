package com.acutest.app.screenshare

import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import io.livekit.android.util.flowDelegate
import java.lang.reflect.Field
import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Host tests for [ScreenSharePlugin.ScreenUnpublishGuard], constructed directly. A
 * [java.lang.reflect.Proxy] plays the Room's own participant listener and records every callback it
 * receives; the SDK's argument objects are allocated without running their constructors, with only
 * the publication's source and track filled in.
 *
 * The invariant under test: every participant listener callback reaches the Room's listener exactly
 * once, with the very same arguments, on the calling thread, before the guard returns, with one
 * exception. A local unpublish whose source is the screen, while `connected` and `retained` both
 * hold, goes to `onWithheld` instead and never reaches the Room. Any other source, either hook
 * returning false or throwing, and every remote unpublish reach the Room unchanged.
 */
@Suppress("DEPRECATION")
class ScreenUnpublishGuardTest {
    /** One callback as the Room's listener saw it. */
    private class Call(val method: Method, val args: List<Any?>, val thread: Thread, val phase: String)

    /**
     * The Room's own listener: records every participant listener callback with the [phase] it
     * arrived in, then throws [failure] if one is set.
     */
    private class RecordingListener {
        val calls = mutableListOf<Call>()
        var phase = "idle"
        var failure: RuntimeException? = null

        val listener =
            Proxy.newProxyInstance(
                listenerType.classLoader,
                arrayOf(listenerType),
                InvocationHandler { proxy, method, args -> handle(proxy, method, args) },
            ) as io.livekit.android.room.participant.ParticipantListener

        private fun handle(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            if (method.declaringClass == Any::class.java) {
                return when (method.name) {
                    "equals" -> proxy === args?.get(0)
                    "hashCode" -> System.identityHashCode(proxy)
                    else -> "RecordingListener"
                }
            }
            calls.add(Call(method, args?.toList() ?: emptyList(), Thread.currentThread(), phase))
            failure?.let { throw it }
            return null
        }
    }

    /** The guard's three hooks; tests flip the answers or make a read throw. */
    private class Hooks(private val room: RecordingListener) {
        var connected = true
        var retained = true
        var connectedFails = false
        var retainedFails = false
        var connectedReads = 0
        val retainedArgs = mutableListOf<Track?>()
        val withheld = mutableListOf<Pair<Thread, String>>()

        fun connected(): Boolean {
            connectedReads++
            if (connectedFails) throw IllegalStateException("state unavailable")
            return connected
        }

        fun retained(track: Track?): Boolean {
            retainedArgs.add(track)
            if (retainedFails) throw IllegalStateException("sender unavailable")
            return retained
        }

        fun onWithheld() {
            withheld.add(Thread.currentThread() to room.phase)
        }
    }

    private val room = RecordingListener()
    private val hooks = Hooks(room)
    private val guard =
        ScreenSharePlugin.ScreenUnpublishGuard(
            room.listener,
            { hooks.connected() },
            { hooks.retained(it) },
        ) {
            hooks.onWithheld()
        }

    private val screenTrack: Track = blank(LocalVideoTrack::class.java)

    private fun localPublication(source: Track.Source, track: Track? = screenTrack): LocalTrackPublication =
        publication(LocalTrackPublication::class.java, source, track)

    private fun remotePublication(source: Track.Source): RemoteTrackPublication =
        publication(RemoteTrackPublication::class.java, source, blank(LocalVideoTrack::class.java))

    /** Calls [block] with the listener's phase set to "during", so a record proves it arrived in time. */
    private fun during(block: () -> Unit) {
        room.phase = "during"
        try {
            block()
        } finally {
            room.phase = "after"
        }
    }

    /** Calls [method] on the guard with [args], unwrapping a reflective throw. */
    private fun invoke(method: Method, args: Array<Any?>) {
        during {
            try {
                method.invoke(guard, *args)
            } catch (e: InvocationTargetException) {
                throw e.targetException
            }
        }
    }

    /** Asserts the Room's listener received exactly one [expected] call, with [args], in time. */
    private fun assertReachedRoomOnce(label: String, expected: Method, args: Array<Any?>) {
        assertEquals("$label: callbacks reaching the Room", 1, room.calls.size)
        val call = room.calls.single()
        assertEquals("$label: callback", expected, call.method)
        assertSame("$label: thread", Thread.currentThread(), call.thread)
        assertEquals("$label: must arrive before the guard returns", "during", call.phase)
        assertEquals("$label: argument count", args.size, call.args.size)
        args.forEachIndexed { i, arg -> assertSame("$label: argument $i", arg, call.args[i]) }
    }

    private fun assertLocalUnpublishReachesRoom(label: String, publication: LocalTrackPublication) {
        val participant = blank(LocalParticipant::class.java)
        room.calls.clear()

        during { guard.onTrackUnpublished(publication, participant) }

        assertReachedRoomOnce(label, localUnpublish, arrayOf(publication, participant))
        assertTrue("$label: nothing withheld", hooks.withheld.isEmpty())
    }

    @Test
    fun everyCallbackReachesTheRoomOnceWithTheSameArgumentsOnTheCallingThread() {
        val methods = listenerMethods()
        assertTrue("expected at least 12 listener callbacks, found ${methods.size}", methods.size >= 12)

        for (method in methods) {
            val args = fakeArgs(method, Track.Source.CAMERA)
            room.calls.clear()

            invoke(method, args)

            assertReachedRoomOnce(method.toString(), method, args)
        }
        assertTrue(hooks.withheld.isEmpty())
    }

    @Test
    fun onlyTheLocalScreenUnpublishIsWithheldWhenItsConditionsHold() {
        val methods = listenerMethods()
        assertTrue(methods.size >= 12)
        assertTrue(methods.contains(localUnpublish))

        for (method in methods) {
            val args = fakeArgs(method, Track.Source.SCREEN_SHARE)
            val withheldBefore = hooks.withheld.size
            room.calls.clear()

            invoke(method, args)

            if (method == localUnpublish) {
                assertTrue("the local screen unpublish must not reach the Room", room.calls.isEmpty())
                assertEquals(withheldBefore + 1, hooks.withheld.size)
            } else {
                assertReachedRoomOnce(method.toString(), method, args)
                assertEquals("$method must not withhold", withheldBefore, hooks.withheld.size)
            }
        }
        assertEquals(1, hooks.withheld.size)
    }

    @Test
    fun aThrowFromTheRoomsListenerReachesTheCallerUnchanged() {
        for (method in listenerMethods()) {
            val failure = IllegalStateException("listener failed in $method")
            room.failure = failure
            val args = fakeArgs(method, Track.Source.CAMERA)
            room.calls.clear()

            try {
                invoke(method, args)
                fail("$method: the listener's throw must reach the caller")
            } catch (thrown: IllegalStateException) {
                assertSame("$method: thrown", failure, thrown)
            }

            assertReachedRoomOnce(method.toString(), method, args)
        }
        assertTrue(hooks.withheld.isEmpty())
    }

    @Test
    fun localPublishReachesTheRoomBeforeTheGuardReturns() {
        val publication = localPublication(Track.Source.SCREEN_SHARE)
        val participant = blank(LocalParticipant::class.java)

        during { guard.onTrackPublished(publication, participant) }

        assertReachedRoomOnce("local publish", localPublish, arrayOf(publication, participant))
        assertTrue(hooks.withheld.isEmpty())
    }

    @Test
    fun localScreenUnpublishWhileConnectedAndRetainedIsWithheld() {
        val publication = localPublication(Track.Source.SCREEN_SHARE)
        val participant = blank(LocalParticipant::class.java)

        during { guard.onTrackUnpublished(publication, participant) }

        assertTrue("the withheld unpublish must not reach the Room", room.calls.isEmpty())
        assertEquals(1, hooks.withheld.size)
        assertSame("onWithheld runs on the calling thread", Thread.currentThread(), hooks.withheld[0].first)
        assertEquals("onWithheld runs before the guard returns", "during", hooks.withheld[0].second)
        assertTrue(hooks.connectedReads >= 1)
        assertEquals(1, hooks.retainedArgs.size)
        assertSame("retained is asked about the publication's track", screenTrack, hooks.retainedArgs[0])
    }

    @Test
    fun localUnpublishOfAnyOtherSourceReachesTheRoom() {
        val others = Track.Source.values().filter { it != Track.Source.SCREEN_SHARE }
        assertTrue(
            others.containsAll(listOf(Track.Source.CAMERA, Track.Source.SCREEN_SHARE_AUDIO, Track.Source.UNKNOWN)),
        )

        for (source in others) {
            assertLocalUnpublishReachesRoom("source $source", localPublication(source))
        }
    }

    @Test
    fun localScreenUnpublishWhileNotConnectedReachesTheRoom() {
        hooks.connected = false

        assertLocalUnpublishReachesRoom("not connected", localPublication(Track.Source.SCREEN_SHARE))
    }

    @Test
    fun localScreenUnpublishOfATrackNotRetainedReachesTheRoom() {
        hooks.retained = false

        assertLocalUnpublishReachesRoom("not retained", localPublication(Track.Source.SCREEN_SHARE))
        assertSame(screenTrack, hooks.retainedArgs.single())
    }

    @Test
    fun localScreenUnpublishReachesTheRoomWhenTheStateReadThrows() {
        hooks.connectedFails = true

        assertLocalUnpublishReachesRoom("state read throws", localPublication(Track.Source.SCREEN_SHARE))
        assertTrue(hooks.connectedReads >= 1)
    }

    @Test
    fun localScreenUnpublishReachesTheRoomWhenTheRetainedCheckThrows() {
        // The plugin's own retained check never throws; this covers the guard's catch by itself.
        hooks.retainedFails = true

        assertLocalUnpublishReachesRoom("retained check throws", localPublication(Track.Source.SCREEN_SHARE))
        assertSame(screenTrack, hooks.retainedArgs.single())
    }

    @Test
    fun remoteUnpublishAlwaysReachesTheRoom() {
        for (source in Track.Source.values()) {
            for (connected in listOf(true, false)) {
                for (retained in listOf(true, false)) {
                    hooks.connected = connected
                    hooks.retained = retained
                    val publication = remotePublication(source)
                    val participant = blank(RemoteParticipant::class.java)
                    room.calls.clear()

                    during { guard.onTrackUnpublished(publication, participant) }

                    assertReachedRoomOnce(
                        "remote $source connected=$connected retained=$retained",
                        remoteUnpublish,
                        arrayOf(publication, participant),
                    )
                }
            }
        }
        assertTrue(hooks.withheld.isEmpty())
    }

    @Test
    fun eachLocalScreenUnpublishIsDecidedOnItsOwn() {
        val participant = blank(LocalParticipant::class.java)

        during { guard.onTrackUnpublished(localPublication(Track.Source.SCREEN_SHARE), participant) }
        assertTrue(room.calls.isEmpty())
        assertEquals(1, hooks.withheld.size)

        hooks.connected = false
        val forwarded = localPublication(Track.Source.SCREEN_SHARE)
        during { guard.onTrackUnpublished(forwarded, participant) }
        assertReachedRoomOnce("after a withheld unpublish", localUnpublish, arrayOf(forwarded, participant))
        assertEquals(1, hooks.withheld.size)

        hooks.connected = true
        room.calls.clear()
        during { guard.onTrackUnpublished(localPublication(Track.Source.SCREEN_SHARE), participant) }
        assertTrue(room.calls.isEmpty())
        assertEquals(2, hooks.withheld.size)
    }

    private companion object {
        /** The listener interface both the guard and the Room implement. */
        val listenerType: Class<*> = io.livekit.android.room.participant.ParticipantListener::class.java

        val localPublish: Method =
            listenerType.getMethod(
                "onTrackPublished",
                LocalTrackPublication::class.java,
                LocalParticipant::class.java,
            )
        val localUnpublish: Method =
            listenerType.getMethod(
                "onTrackUnpublished",
                LocalTrackPublication::class.java,
                LocalParticipant::class.java,
            )
        val remoteUnpublish: Method =
            listenerType.getMethod(
                "onTrackUnpublished",
                RemoteTrackPublication::class.java,
                RemoteParticipant::class.java,
            )

        private val unsafe: Any =
            Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)!!
        private val allocateInstance: Method = unsafe.javaClass.getMethod("allocateInstance", Class::class.java)

        /** The source setter is internal to the SDK; its JVM name is public. */
        private val setSource: Method =
            TrackPublication::class.java.getMethod("setSource\$livekit_android_sdk_release", Track.Source::class.java)

        /** The backing store of [TrackPublication.track], left null by [blank]. */
        private val trackStore: Field =
            TrackPublication::class.java.getDeclaredField("track\$delegate").apply { isAccessible = true }

        /** Concrete stand-ins for abstract parameter types. */
        private val concrete: Map<Class<*>, Class<*>> = mapOf(Track::class.java to LocalVideoTrack::class.java)

        private val primitiveDefaults: Map<Class<*>?, Any> =
            mapOf(
                Boolean::class.javaPrimitiveType to false,
                Byte::class.javaPrimitiveType to 0.toByte(),
                Short::class.javaPrimitiveType to 0.toShort(),
                Int::class.javaPrimitiveType to 0,
                Long::class.javaPrimitiveType to 0L,
                Float::class.javaPrimitiveType to 0f,
                Double::class.javaPrimitiveType to 0.0,
                Char::class.javaPrimitiveType to Char(0),
            )

        /** An instance of [type] allocated without running any constructor; every field is zero. */
        fun allocate(type: Class<*>): Any = allocateInstance.invoke(unsafe, type)!!

        fun <T : Any> blank(type: Class<T>): T = type.cast(allocate(type))!!

        /** A blank publication with only its [source] and [track] set; both are read back. */
        fun <T : TrackPublication> publication(type: Class<T>, source: Track.Source, track: Track?): T {
            val publication = blank(type)
            setSource.invoke(publication, source)
            trackStore.set(publication, flowDelegate(track))
            check(publication.source == source) { "fixture source not set" }
            check(publication.track === track) { "fixture track not set" }
            return publication
        }

        /** Every callback of the listener interface, in a stable order. */
        fun listenerMethods(): List<Method> =
            listenerType.methods
                .filter { !Modifier.isStatic(it.modifiers) }
                .sortedBy { it.toGenericString() }

        /** A fresh non-null argument for each parameter of [method]; publications carry [source]. */
        fun fakeArgs(method: Method, source: Track.Source): Array<Any?> =
            method.parameterTypes.mapIndexed { i, type -> fakeArg(method, i, type, source) }.toTypedArray()

        @Suppress("UNCHECKED_CAST")
        private fun fakeArg(method: Method, index: Int, type: Class<*>, source: Track.Source): Any =
            when {
                type.isPrimitive -> primitiveDefaults[type] ?: error("$method: no default for $type")
                type == String::class.java -> "argument $index"
                type == ByteArray::class.java -> byteArrayOf(index.toByte())
                Throwable::class.java.isAssignableFrom(type) ->
                    type.getConstructor(String::class.java).newInstance("argument $index")
                TrackPublication::class.java.isAssignableFrom(type) ->
                    publication(type as Class<TrackPublication>, source, blank(LocalVideoTrack::class.java))
                type.isInterface || Modifier.isAbstract(type.modifiers) ->
                    allocate(concrete[type] ?: error("$method: add a concrete stand-in for $type"))
                else -> allocate(type)
            }
    }
}
