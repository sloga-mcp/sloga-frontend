package com.acutest.app;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * Tells the web layer this build's versionCode and which app installed it,
 * so FossUpdateNotice.tsx can say a newer foss APK is out on sloga.gg when
 * nothing else will deliver it.
 *
 * It installs nothing: there is no downloader here and no
 * REQUEST_INSTALL_PACKAGES, which lives only in the `sideload` source set.
 * It needs no permission and no <queries> entry, since the only package it
 * asks about is this one. The list of installers that update the app
 * themselves (F-Droid clients, Obtainium) lives in FossUpdateNotice.tsx.
 */
@CapacitorPlugin(name = "UpdateNotice")
public class UpdateNoticePlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        long versionCode;
        try {
            PackageInfo info = pm.getPackageInfo(pkg, 0);
            versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            call.reject("versionCode unavailable");
            return;
        }
        String installer = installerOf(pm, pkg);
        JSObject result = new JSObject();
        result.put("versionCode", versionCode);
        // JSONObject drops a key put with null; the web layer expects null itself.
        result.put("installer", installer != null ? installer : JSONObject.NULL);
        call.resolve(result);
    }

    /**
     * The package that installed this app, or null when none was recorded
     * (an adb install, for one) or it can't be read. One try covers both
     * branches: only the R+ call declares NameNotFoundException, and the
     * older call throws IllegalArgumentException for an unknown package.
     */
    @SuppressWarnings("deprecation")
    private static String installerOf(PackageManager pm, String pkg) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return pm.getInstallSourceInfo(pkg).getInstallingPackageName();
            }
            return pm.getInstallerPackageName(pkg);
        } catch (PackageManager.NameNotFoundException | IllegalArgumentException e) {
            return null;
        }
    }
}
