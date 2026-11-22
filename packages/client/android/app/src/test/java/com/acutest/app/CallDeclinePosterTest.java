package com.acutest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.net.URI;
import java.util.Arrays;
import java.util.Locale;

/**
 * Host tests for the three address rules of {@link CallDeclinePoster}:
 * isChannelId, isAllowedApiUrl and declineUrl. They take strings and return
 * strings or booleans, so they run on the JVM with nothing standing in for
 * Android.
 *
 * The decline request carries the session token. The chat id becomes part of
 * the request path and the stored API address chooses the host, so anything
 * that is not a chat id must stay out of the path, and the token must never
 * go out in the clear or to an address whose host can be read two ways.
 *
 * The addresses and the id in these tests are written out, not built from
 * the class, so a changed rule fails here.
 *
 * Not covered: post() and the request itself, which need a Context, a
 * broadcast and a network. The host is read by java.net.URI as the JVM ships
 * it; the phone's own copy of that class is not what runs here.
 */
public class CallDeclinePosterTest {
    /** 26 characters, each one a digit or an upper-case letter. */
    private static final String ID = "01JCM8Q4ZT5N7R2K9XW3V6B0HD";

    private static String withCharAt(String s, int index, char c) {
        return s.substring(0, index) + c + s.substring(index + 1);
    }

    private static String repeat(char c, int n) {
        char[] chars = new char[n];
        Arrays.fill(chars, c);
        return new String(chars);
    }

    private static void assertAllowed(String apiUrl) {
        assertTrue("must be allowed: " + apiUrl, CallDeclinePoster.isAllowedApiUrl(apiUrl));
    }

    private static void assertRefused(String apiUrl) {
        assertFalse("must be refused: " + apiUrl, CallDeclinePoster.isAllowedApiUrl(apiUrl));
    }

    private static void assertNotAnId(String id) {
        assertFalse("must not be a chat id: " + id, CallDeclinePoster.isChannelId(id));
    }

    /** A string of exactly 26 characters that must still not be a chat id. */
    private static void assertNotAnIdAtFullLength(String id) {
        assertEquals("the sample must be 26 characters: " + id, 26, id.length());
        assertNotAnId(id);
    }

    // isChannelId

    @Test
    public void twentySixDigitsAndUpperCaseLettersAreAChatId() {
        assertEquals(26, ID.length());
        assertTrue(CallDeclinePoster.isChannelId(ID));
        assertTrue(CallDeclinePoster.isChannelId("00000000000000000000000000"));
        assertTrue(CallDeclinePoster.isChannelId("99999999999999999999999999"));
        assertTrue(CallDeclinePoster.isChannelId("AAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assertTrue(CallDeclinePoster.isChannelId("ZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
        assertTrue(CallDeclinePoster.isChannelId("0123456789ABCDEFGHIJKLMNOP"));
        assertTrue(CallDeclinePoster.isChannelId("QRSTUVWXYZ0123456789ABCDEF"));
    }

    @Test
    public void nullAndEmptyAreNotChatIds() {
        assertNotAnId(null);
        assertNotAnId("");
    }

    @Test
    public void anyOtherLengthIsNotAChatId() {
        assertNotAnId("0");
        assertNotAnId("01JCM8Q4ZT5N7R2K9XW3V6B0H");
        assertNotAnId("01JCM8Q4ZT5N7R2K9XW3V6B0HDA");
        assertNotAnId("01JCM8Q4ZT5N7R2K9XW3V6B0HD01JCM8Q4ZT5N7R2K9XW3V6B0HD");
        for (int n = 1; n <= 60; n++) {
            if (n == 26) continue;
            assertNotAnId(repeat('A', n));
            assertNotAnId(repeat('7', n));
        }
    }

    @Test
    public void lowerCaseIsNotAChatId() {
        assertNotAnIdAtFullLength("01jcm8q4zt5n7r2k9xw3v6b0hd");
        assertNotAnIdAtFullLength(ID.toLowerCase(Locale.ROOT));
        assertNotAnIdAtFullLength("abcdefghijklmnopqrstuvwxyz");
        for (int i = 0; i < 26; i++) {
            assertNotAnIdAtFullLength(withCharAt(ID, i, 'a'));
            assertNotAnIdAtFullLength(withCharAt(ID, i, 'z'));
        }
    }

    @Test
    public void aCharacterThatIsNotADigitOrAnUpperCaseLetterIsRefusedAtEveryPosition() {
        // The last six are the characters right next to 0-9 and A-Z in ASCII.
        String bad = ".?#%&=+-_~;,'\"\\*!$()<>|^]}" + "/:@[`{";
        for (int b = 0; b < bad.length(); b++) {
            for (int i = 0; i < 26; i++) {
                assertNotAnIdAtFullLength(withCharAt(ID, i, bad.charAt(b)));
            }
        }
    }

    @Test
    public void pathPiecesAreNotChatIds() {
        assertNotAnIdAtFullLength("..JCM8Q4ZT5N7R2K9XW3V6B0HD");
        assertNotAnIdAtFullLength("../CM8Q4ZT5N7R2K9XW3V6B0HD");
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7R2K9XW3V6B/..");
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7/2K9XW3V6B0HD");
        assertNotAnIdAtFullLength("/1JCM8Q4ZT5N7R2K9XW3V6B0HD");
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7R2K9XW3V6B0H/");
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7R2K9XW3V6B0?A");
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7R2K9XW3V6B0H#");
        assertNotAnIdAtFullLength("%2E%2E%2FT5N7R2K9XW3V6B0HD");
        assertNotAnIdAtFullLength("../../../../users/@me/dms/");
        assertNotAnIdAtFullLength("..........................");
        assertNotAnId("..");
        assertNotAnId("/");
        assertNotAnId(ID + "/");
        assertNotAnId(ID + "/..");
        assertNotAnId(ID + "?a=1");
        assertNotAnId(ID + "#a");
        assertNotAnId("../" + ID);
    }

    @Test
    public void whiteSpaceIsNeverPartOfAChatId() {
        String spaces = " \t\n\r\f\0";
        for (int s = 0; s < spaces.length(); s++) {
            char c = spaces.charAt(s);
            for (int i = 0; i < 26; i++) {
                assertNotAnIdAtFullLength(withCharAt(ID, i, c));
            }
            assertNotAnId(ID + c);
            assertNotAnId(c + ID);
        }
        // A line end in the last place is what a careless pattern lets through.
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7R2K9XW3V6B0H\n");
        assertNotAnIdAtFullLength(repeat(' ', 26));
    }

    @Test
    public void lettersAndDigitsOutsideAsciiAreNotPartOfAChatId() {
        // Upper-case letters and digits to Character.isUpperCase and
        // Character.isDigit, and none of them belongs in a chat id: E acute,
        // Greek Alpha, Cyrillic A, full-width A, Arabic-Indic one, Devanagari
        // three, full-width one.
        int[] foreign = {0x00C9, 0x0391, 0x0410, 0xFF21, 0x0661, 0x0969, 0xFF11};
        for (int code : foreign) {
            char c = (char) code;
            assertTrue(Character.isUpperCase(c) || Character.isDigit(c));
            for (int i = 0; i < 26; i++) {
                assertNotAnIdAtFullLength(withCharAt(ID, i, c));
            }
        }
        assertNotAnIdAtFullLength(repeat((char) 0x0661, 26));
        assertNotAnIdAtFullLength(repeat((char) 0x0410, 26));
        // A digit from outside the basic plane (mathematical bold one) takes
        // two places.
        String boldOne = new String(Character.toChars(0x1D7CF));
        assertNotAnIdAtFullLength("01JCM8Q4ZT5N7R2K9XW3V6B0" + boldOne);
        assertNotAnIdAtFullLength((char) 0x7F + "1JCM8Q4ZT5N7R2K9XW3V6B0HD");
        assertNotAnIdAtFullLength((char) 0x80 + "1JCM8Q4ZT5N7R2K9XW3V6B0HD");
    }

    // isAllowedApiUrl

    @Test
    public void httpsAddressesAreAllowed() {
        assertAllowed("https://api.example.com");
        assertAllowed("https://api.example.com/");
        assertAllowed("https://api.example.com:8443");
        assertAllowed("https://example.com/api");
        assertAllowed("https://example.com/api/0.8");
        assertAllowed("https://192.0.2.7");
        assertAllowed("https://192.0.2.7:14702");
        assertAllowed("https://localhost");
        assertAllowed("https://a-b.example.com");
    }

    @Test
    public void theSchemeIsReadWithoutRegardToCase() {
        assertAllowed("HTTPS://api.example.com");
        assertAllowed("Https://API.EXAMPLE.COM");
        assertAllowed("HTTP://localhost:14702");
        assertAllowed("http://LOCALHOST:14702");
        assertRefused("HTTP://api.example.com");
        assertRefused("Http://API.EXAMPLE.COM");
    }

    @Test
    public void plainHttpIsAllowedForTheThreeDevelopmentHosts() {
        assertAllowed("http://localhost");
        assertAllowed("http://localhost/");
        assertAllowed("http://localhost:14702");
        assertAllowed("http://localhost:14702/api");
        assertAllowed("http://127.0.0.1");
        assertAllowed("http://127.0.0.1:14702");
        assertAllowed("http://10.0.2.2");
        assertAllowed("http://10.0.2.2:14702");
    }

    @Test
    public void plainHttpToAnyOtherHostIsRefused() {
        assertRefused("http://api.example.com");
        assertRefused("http://api.example.com:443");
        assertRefused("http://example.com/api");
        assertRefused("http://192.168.1.10:14702");
        assertRefused("http://10.0.2.3");
        assertRefused("http://10.0.2.20");
        assertRefused("http://10.0.2.22");
        assertRefused("http://127.0.0.2");
        assertRefused("http://127.0.0.11");
        assertRefused("http://127.1");
        assertRefused("http://0.0.0.0");
        assertRefused("http://2130706433");
        assertRefused("http://0x7f.0.0.1");
        assertRefused("http://[::1]");
        assertRefused("http://[::1]:14702");
        assertRefused("http://[::ffff:127.0.0.1]");
    }

    @Test
    public void aDevelopmentHostInsideAnotherNameIsRefused() {
        assertRefused("http://localhost.evil.example");
        assertRefused("http://evil.example/localhost");
        assertRefused("http://evil.example/http://localhost");
        assertRefused("http://localhost-evil.example");
        assertRefused("http://xlocalhost");
        assertRefused("http://localhostx");
        assertRefused("http://local.host");
        assertRefused("http://127.0.0.1.evil.example");
        assertRefused("http://10.0.2.2.evil.example");
        assertRefused("http://evil.example:127/");
        // A dot at the end makes a different name.
        assertRefused("http://localhost.");
        assertRefused("http://127.0.0.1.");
        assertRefused("http://10.0.2.2.");
        assertRefused("http://api.example.com.");
    }

    @Test
    public void everyOtherSchemeIsRefused() {
        assertRefused("ws://localhost");
        assertRefused("ws://localhost:14703");
        assertRefused("wss://api.example.com");
        assertRefused("ftp://localhost");
        assertRefused("file:///data/data/com.acutest.app/files");
        assertRefused("file://localhost/etc/hosts");
        assertRefused("content://com.acutest.app/api");
        assertRefused("intent://api.example.com");
        assertRefused("javascript:alert(1)");
        assertRefused("data:text/plain,https://api.example.com");
        assertRefused("httpss://api.example.com");
        assertRefused("xhttps://api.example.com");
        assertRefused("http+unix://localhost");
        assertRefused("s://api.example.com");
    }

    @Test
    public void anAddressWithoutASchemeOrWithoutAHostIsRefused() {
        assertRefused(null);
        assertRefused("");
        assertRefused("/");
        assertRefused("api.example.com");
        assertRefused("api.example.com/api");
        assertRefused("//api.example.com");
        assertRefused("//localhost");
        assertRefused("//127.0.0.1:14702");
        assertRefused("://api.example.com");
        assertRefused("localhost");
        assertRefused("localhost:14702");
        assertRefused("127.0.0.1:14702");
        assertRefused("https");
        assertRefused("https:");
        assertRefused("https:/");
        assertRefused("https://");
        assertRefused("https:///");
        assertRefused("https:///api");
        assertRefused("https:/api.example.com");
        assertRefused("https:api.example.com");
        assertRefused("https://:8443");
        assertRefused("https://.");
        assertRefused("http://");
        assertRefused("http:///localhost");
        assertRefused("http:localhost");
    }

    @Test
    public void aHostThatIsNotAPlainNameIsRefused() {
        // The parser finds no host in these. Without a host that is checked,
        // nothing may be sent.
        assertRefused("https://api_example.com");
        assertRefused("https://api.example.com:port");
        assertRefused("https://api.example.com:80:80");
        assertRefused("https://api.example.com:-1");
        assertRefused("http://localhost:x");
        assertRefused("https://api.example.com%2Eevil.example");
        assertRefused("https://api.example.com%40evil.example");
        assertRefused("https://-api.example.com-");
        assertRefused("https://[::1");
        assertRefused("https://api.example.com,evil.example");
        assertRefused("https://api.example.com;evil.example");
    }

    @Test
    public void aSignInPartIsRefused() {
        assertRefused("https://good.example@evil.example");
        assertRefused("https://api.example.com@evil.example");
        assertRefused("https://api.example.com:443@evil.example");
        assertRefused("https://user:pw@api.example.com");
        assertRefused("https://user@api.example.com");
        assertRefused("https://@api.example.com");
        assertRefused("http://localhost@evil.example");
        assertRefused("http://localhost:14702@evil.example");
        assertRefused("http://127.0.0.1@evil.example");
        // Refused even though the host a careful parser finds is an allowed one.
        assertRefused("http://evil.example@localhost");
        assertRefused("https://evil.example@api.example.com");
    }

    @Test
    public void anAtSignAnywhereIsRefused() {
        assertRefused("https://api.example.com/@evil.example");
        assertRefused("https://api.example.com/users/@me");
        assertRefused("https://api.example.com/api@");
        assertRefused("http://localhost/@");
        assertRefused("@");
    }

    @Test
    public void aQueryIsRefused() {
        assertRefused("https://api.example.com?");
        assertRefused("https://api.example.com/?");
        assertRefused("https://api.example.com?a=1");
        assertRefused("https://api.example.com/api?a=1");
        assertRefused("https://evil.example?api.example.com");
        assertRefused("http://localhost?a");
    }

    @Test
    public void aFragmentIsRefused() {
        assertRefused("https://api.example.com#");
        assertRefused("https://api.example.com/#");
        assertRefused("https://api.example.com#a");
        assertRefused("https://api.example.com/api#a");
        assertRefused("https://evil.example#api.example.com");
        assertRefused("http://localhost#a");
    }

    @Test
    public void aBackslashIsRefused() {
        assertRefused("https://api.example.com\\");
        assertRefused("https://api.example.com\\@evil.example");
        assertRefused("https://evil.example\\.api.example.com");
        assertRefused("https://api.example.com\\evil.example");
        assertRefused("https:\\\\api.example.com");
        assertRefused("https:/\\api.example.com");
        assertRefused("https://api.example.com/api\\");
        assertRefused("http://localhost\\.evil.example");
        assertRefused("http://evil.example\\localhost");
    }

    @Test
    public void whiteSpaceAndControlCharactersAreRefused() {
        // Space, tab, line feed, carriage return, form feed, NUL, 1, escape
        // and delete.
        int[] bad = {0x20, 0x09, 0x0A, 0x0D, 0x0C, 0x00, 0x01, 0x1B, 0x7F};
        for (int code : bad) {
            char c = (char) code;
            assertRefused(c + "https://api.example.com");
            assertRefused("https://api.example.com" + c);
            assertRefused("https:" + c + "//api.example.com");
            assertRefused("https://api" + c + ".example.com");
            assertRefused("https://api.example.com/a" + c);
            assertRefused("http://localhost" + c);
            assertRefused("http://evil.example" + c + "localhost");
        }
        assertRefused(" ");
        assertRefused("https://api.example.com\r\nX-Session-Token: a");
        assertRefused("https://api.example.com/\nhttps://evil.example");
    }

    @Test
    public void charactersOutsideAsciiAreRefused() {
        char cyrillicA = (char) 0x0430;
        char fullWidthFullStop = (char) 0xFF0E;
        char ideographicFullStop = (char) 0x3002;
        char fullWidthAt = (char) 0xFF20;
        char eAcute = (char) 0x00E9;
        char zeroWidthSpace = (char) 0x200B;
        // In the host. Some parsers read the two full stops as a dot and the
        // full-width at sign as an at sign.
        assertRefused("https://" + cyrillicA + "pi.example.com");
        assertRefused("https://api" + fullWidthFullStop + "example.com");
        assertRefused("https://api.example.com" + ideographicFullStop + "evil.example");
        assertRefused("https://evil.example" + fullWidthAt + "api.example.com");
        assertRefused("http://localhost" + ideographicFullStop + "evil.example");
        // After the host, where the parser itself has no objection.
        assertRefused("https://api.example.com/" + eAcute);
        assertRefused("https://api.example.com/api" + (char) 0x80);
        assertRefused("https://api.example.com/" + zeroWidthSpace);
        assertRefused("http://localhost/" + eAcute);
        assertRefused("https://api.example.com/" + new String(Character.toChars(0x1F600)));
    }

    // declineUrl

    @Test
    public void theDeclineAddressIsTheApiAddressThenTheChatThenDeclineCall() {
        assertEquals(
                "https://api.example.com/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call",
                CallDeclinePoster.declineUrl("https://api.example.com", ID));
        assertEquals(
                "https://example.com:8443/api/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call",
                CallDeclinePoster.declineUrl("https://example.com:8443/api", ID));
        assertEquals(
                "http://10.0.2.2:14702/channels/00000000000000000000000000/decline_call",
                CallDeclinePoster.declineUrl(
                        "http://10.0.2.2:14702", "00000000000000000000000000"));
        assertEquals(
                "http://localhost/channels/ZZZZZZZZZZZZZZZZZZZZZZZZZZ/decline_call",
                CallDeclinePoster.declineUrl("http://localhost", "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
    }

    @Test
    public void trailingSlashesOnTheApiAddressNeverDoubleUp() {
        String[] slashes = {"", "/", "//", "///", "//////////"};
        for (String s : slashes) {
            assertEquals(
                    "https://api.example.com/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call",
                    CallDeclinePoster.declineUrl("https://api.example.com" + s, ID));
            assertEquals(
                    "https://example.com/api/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call",
                    CallDeclinePoster.declineUrl("https://example.com/api" + s, ID));
            assertEquals(
                    "http://127.0.0.1:14702/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call",
                    CallDeclinePoster.declineUrl("http://127.0.0.1:14702" + s, ID));
            String built = CallDeclinePoster.declineUrl("https://example.com/api" + s, ID);
            assertEquals("the only double slash follows https:", 6, built.lastIndexOf("//"));
        }
    }

    @Test
    public void theDeclineAddressReadsBackAsTheSameHostAndPath() throws Exception {
        String built = CallDeclinePoster.declineUrl("https://example.com:8443/api/", ID);
        URI uri = new URI(built);
        assertEquals("https", uri.getScheme());
        assertEquals("example.com", uri.getHost());
        assertEquals(8443, uri.getPort());
        assertEquals("/api/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call", uri.getRawPath());
        assertNull(uri.getRawUserInfo());
        assertNull(uri.getRawQuery());
        assertNull(uri.getRawFragment());
        assertTrue(CallDeclinePoster.isAllowedApiUrl(built));
    }

    @Test
    public void nothingIsBuiltWithoutAnApiAddress() {
        assertNull(CallDeclinePoster.declineUrl(null, ID));
        assertNull(CallDeclinePoster.declineUrl("", ID));
        assertNull(CallDeclinePoster.declineUrl("/", ID));
        assertNull(CallDeclinePoster.declineUrl("///", ID));
        assertNull(CallDeclinePoster.declineUrl(null, null));
    }

    @Test
    public void nothingIsBuiltForAnAddressThatIsNotAllowed() {
        assertNull(CallDeclinePoster.declineUrl("http://api.example.com", ID));
        assertNull(CallDeclinePoster.declineUrl("http://api.example.com/", ID));
        assertNull(CallDeclinePoster.declineUrl("http://localhost.evil.example/", ID));
        assertNull(CallDeclinePoster.declineUrl("ws://localhost", ID));
        assertNull(CallDeclinePoster.declineUrl("api.example.com", ID));
        assertNull(CallDeclinePoster.declineUrl("https://", ID));
        assertNull(CallDeclinePoster.declineUrl("https:///", ID));
        assertNull(CallDeclinePoster.declineUrl("https://good.example@evil.example", ID));
        assertNull(CallDeclinePoster.declineUrl("https://good.example@evil.example/", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com?a=1", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com/?", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com?/", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com/#", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com#/", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com\\", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com /", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com/\n", ID));
        assertNull(CallDeclinePoster.declineUrl("https://api.example.com/" + (char) 0xE9, ID));
    }

    @Test
    public void nothingIsBuiltForAnIdThatIsNotAChatId() {
        String api = "https://api.example.com";
        assertEquals(
                "https://api.example.com/channels/01JCM8Q4ZT5N7R2K9XW3V6B0HD/decline_call",
                CallDeclinePoster.declineUrl(api, ID));
        assertNull(CallDeclinePoster.declineUrl(api, null));
        assertNull(CallDeclinePoster.declineUrl(api, ""));
        assertNull(CallDeclinePoster.declineUrl(api, "01JCM8Q4ZT5N7R2K9XW3V6B0H"));
        assertNull(CallDeclinePoster.declineUrl(api, "01JCM8Q4ZT5N7R2K9XW3V6B0HDA"));
        assertNull(CallDeclinePoster.declineUrl(api, "01jcm8q4zt5n7r2k9xw3v6b0hd"));
        assertNull(CallDeclinePoster.declineUrl(api, "../CM8Q4ZT5N7R2K9XW3V6B0HD"));
        assertNull(CallDeclinePoster.declineUrl(api, "01JCM8Q4ZT5N7/2K9XW3V6B0HD"));
        assertNull(CallDeclinePoster.declineUrl(api, "01JCM8Q4ZT5N7R2K9XW3V6B0?A"));
        assertNull(CallDeclinePoster.declineUrl(api, "01JCM8Q4ZT5N7R2K9XW3V6B0H#"));
        assertNull(CallDeclinePoster.declineUrl(api, "01JCM8Q4ZT5N7R2K9XW3V6B0H\n"));
        assertNull(CallDeclinePoster.declineUrl(api, ID + "/"));
        assertNull(CallDeclinePoster.declineUrl(api, ID + "/../../users/@me"));
        assertNull(CallDeclinePoster.declineUrl(api, " " + ID));
    }
}
