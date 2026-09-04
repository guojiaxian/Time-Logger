package com.timelogger.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 使用信任自签名证书的 WebViewClient, 保障 APK 内同步接口可用
        bridge.setWebViewClient(new SSLTrustWebViewClient(bridge));
    }
}
