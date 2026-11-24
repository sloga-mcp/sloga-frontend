package com.acutest.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;

/**
 * Names and photos of the people and group chats that can call this device,
 * kept on the phone so a ringing notification can say who is calling.
 *
 * The call push carries ids only, and it can arrive while the web layer is
 * not running. So the web layer hands over its list while the app is open,
 * and the notifier looks the ids up here when a push arrives.
 *
 * The list lives in MODE_PRIVATE SharedPreferences, which the Android sandbox
 * keeps unreadable by other apps. Every entry is its own key, so a lookup at
 * ring time is one map read with nothing to parse: "u:<id>" is a user's name,
 * "a:<id>" is a user's photo URL and "c:<id>" is a group chat's name.
 *
 * The file names the people this account talks to. It belongs to the
 * signed-in account, so clear() has to run at sign-out, and the file has to
 * be listed in the backup and device-transfer rules like the other private
 * preference files so it never leaves the phone.
 *
 * No method here throws. A ring must still show when the list is missing or
 * unreadable, so a failed read answers null and a failed write does nothing.
 */
public final class CallContactStore {
    private static final String TAG = "SlogaCalls";

    private static final String PREFS = "call_contacts";
    private static final String KEY_USER = "u:";
    private static final String KEY_AVATAR = "a:";
    private static final String KEY_CHANNEL = "c:";

    private static final int MAX_USERS = 2000;
    private static final int MAX_CHANNELS = 500;
    private static final int NAME_MAX = 64;
    private static final String AVATAR_PREFIX = "https://";
    // Real ids are 26 characters and real photo URLs a few hundred. These two
    // limits only keep a malformed entry from growing the file, which is
    // loaded whole into memory the first time a push needs it.
    private static final int ID_MAX = 64;
    private static final int AVATAR_MAX = 2048;

    private CallContactStore() {}

    /**
     * Swap the stored list for a new one. users holds objects with "id",
     * "name" and an optional "avatar"; channels holds objects with "id" and
     * "name". A null array stores no entries of that kind.
     *
     * Kept: at most 2000 users and 500 channels, in the order given, the
     * first entry winning when an id repeats. Dropped: an entry whose id or
     * name is missing, empty or not text. Names are trimmed and cut to 64
     * characters. A photo is kept only when it starts with https://.
     */
    public static void replace(Context ctx, JSONArray users, JSONArray channels) {
        try {
            SharedPreferences.Editor editor = prefs(ctx).edit();
            // An editor runs its clear() before its own puts, so the old list
            // goes and the new one arrives in a single change. A reader sees
            // one whole list or the other, never a mix and never a gap.
            editor.clear();
            putUsers(editor, users);
            putChannels(editor, channels);
            // apply() swaps the in-memory copy right away and writes the file
            // in the background. If the process dies before the write lands,
            // the previous list stays, and the web layer sends a new one the
            // next time it runs.
            editor.apply();
        } catch (Exception e) {
            // Only the kind of failure is logged, never an entry.
            Log.w(TAG, "Could not store call contacts: " + e.getClass().getSimpleName());
        }
    }

    /** Forget every name and photo. For sign-out. */
    public static void clear(Context ctx) {
        try {
            // commit(), not apply(): the names must be off the disk before
            // sign-out carries on, even if the process is killed right after.
            prefs(ctx).edit().clear().commit();
        } catch (Exception e) {
            Log.w(TAG, "Could not clear call contacts: " + e.getClass().getSimpleName());
        }
    }

    /** The stored name of a user, or null when there is none. */
    @Nullable
    public static String userName(Context ctx, @Nullable String userId) {
        return read(ctx, KEY_USER, userId);
    }

    /** The stored https photo URL of a user, or null when there is none. */
    @Nullable
    public static String userAvatar(Context ctx, @Nullable String userId) {
        String avatar = read(ctx, KEY_AVATAR, userId);
        // Checked again on the way out, so a value written by an older build
        // or by a damaged file is never handed to the code that fetches it.
        return isHttpsUrl(avatar) ? avatar : null;
    }

    /** The stored name of a group chat, or null when there is none. */
    @Nullable
    public static String channelName(Context ctx, @Nullable String channelId) {
        return read(ctx, KEY_CHANNEL, channelId);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Nullable
    private static String read(Context ctx, String prefix, @Nullable String id) {
        if (id == null || id.isEmpty()) return null;
        try {
            String value = prefs(ctx).getString(prefix + id, null);
            return value == null || value.isEmpty() ? null : value;
        } catch (Exception e) {
            return null;
        }
    }

    private static void putUsers(SharedPreferences.Editor editor, @Nullable JSONArray users) {
        if (users == null) return;
        HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < users.length() && seen.size() < MAX_USERS; i++) {
            JSONObject user = users.optJSONObject(i);
            if (user == null) continue;
            String id = idOf(user);
            String name = nameOf(user);
            if (id == null || name == null || !seen.add(id)) continue;
            editor.putString(KEY_USER + id, name);
            String avatar = textOf(user, "avatar");
            if (isHttpsUrl(avatar)) editor.putString(KEY_AVATAR + id, avatar);
        }
    }

    private static void putChannels(
            SharedPreferences.Editor editor, @Nullable JSONArray channels) {
        if (channels == null) return;
        HashSet<String> seen = new HashSet<>();
        for (int i = 0; i < channels.length() && seen.size() < MAX_CHANNELS; i++) {
            JSONObject channel = channels.optJSONObject(i);
            if (channel == null) continue;
            String id = idOf(channel);
            String name = nameOf(channel);
            if (id == null || name == null || !seen.add(id)) continue;
            editor.putString(KEY_CHANNEL + id, name);
        }
    }

    /**
     * The value under key when it is text, else null. JSONObject.optString is
     * not used because it turns numbers, booleans and JSON null into text.
     */
    @Nullable
    private static String textOf(JSONObject entry, String key) {
        Object value = entry.opt(key);
        return value instanceof String ? (String) value : null;
    }

    @Nullable
    private static String idOf(JSONObject entry) {
        String id = textOf(entry, "id");
        if (id == null || id.isEmpty() || id.length() > ID_MAX) return null;
        return id;
    }

    /** The entry's name, trimmed and cut to NAME_MAX characters, or null when it is empty. */
    @Nullable
    private static String nameOf(JSONObject entry) {
        String raw = textOf(entry, "name");
        if (raw == null) return null;
        String name = raw.trim();
        if (name.length() > NAME_MAX) name = name.substring(0, NAME_MAX);
        // A cut, here or in the web layer, can land between the two halves of
        // an emoji. The orphaned first half is dropped instead of stored.
        if (!name.isEmpty() && Character.isHighSurrogate(name.charAt(name.length() - 1))) {
            name = name.substring(0, name.length() - 1);
        }
        return name.isEmpty() ? null : name;
    }

    private static boolean isHttpsUrl(@Nullable String value) {
        return value != null
                && value.startsWith(AVATAR_PREFIX)
                && value.length() > AVATAR_PREFIX.length()
                && value.length() <= AVATAR_MAX;
    }
}
