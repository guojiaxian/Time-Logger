package com.timelogger.app;

import android.graphics.Color;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 使用信任自签名证书的 WebViewClient, 保障 APK 内同步接口可用
        bridge.setWebViewClient(new SSLTrustWebViewClient(bridge));

        // 沉浸式状态栏: WebView 内容延伸到状态栏/导航栏之下, 系统栏全透明
        // 顶部让位由网页内 CSS 处理 (html.is-native .app 的 padding-top)
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
    }
}
