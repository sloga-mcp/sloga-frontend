package com.acutest.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Self-update for sideloaded builds: the web layer compares versionCode
 * against the published manifest, then calls downloadAndInstall with the
 * APK URL. Download goes through DownloadManager; when it finishes we
 * hand the file to the system package installer.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("versionCode",
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                            ? info.getLongVersionCode()
                            : info.versionCode);
            result.put("versionName", info.versionName);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to read package info", e);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("A https url is required");
            return;
        }

        Context context = getContext();
        File target = new File(
                context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                "sloga-update.apk");
        if (target.exists() && !target.delete()) {
            call.reject("Could not clear previous update file");
            return;
        }

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url))
                .setTitle("Sloga update")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                .setDestinationInExternalFilesDir(
                        context, Environment.DIRECTORY_DOWNLOADS, "sloga-update.apk");

        long downloadId = manager.enqueue(request);

        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;
                ctx.unregisterReceiver(this);

                DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
                try (android.database.Cursor cursor = manager.query(query)) {
                    if (!cursor.moveToFirst()) {
                        call.reject("Download vanished");
                        return;
                    }
                    int status = cursor.getInt(
                            cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    if (status != DownloadManager.STATUS_SUCCESSFUL) {
                        call.reject("Download failed with status " + status);
                        return;
                    }
                }

                Uri apkUri = FileProvider.getUriForFile(
                        ctx, ctx.getPackageName() + ".fileprovider", target);
                Intent install = new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(apkUri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(install);
                call.resolve();
            }
        };

        ContextCompat.registerReceiver(
                context,
                receiver,
                new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED);
    }
}
