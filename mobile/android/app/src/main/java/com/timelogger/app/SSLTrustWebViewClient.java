package com.timelogger.app;

import android.app.Activity;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import android.net.http.SslError;
import android.webkit.WebViewClient;
import android.view.Window;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/**
 * 信任局域网内自签名 HTTPS 证书的 WebViewClient。
 * 时间记录器同步服务器使用 10 年期自签名证书, 标准 WebView 会拒绝连接,
 * 导致 APK 内同步接口不可用; 此处放行 SSL 错误。
 * 仅适用于可信局域网环境。
 */
public class SSLTrustWebViewClient extends BridgeWebViewClient {

    public SSLTrustWebViewClient(Bridge bridge) {
        super(bridge);
    }

    // 页面/主资源加载遇到 SSL 错误(自签名证书)时放行
    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.proceed();
    }

    // 沉浸式联动: 页面加载完成后按网页主题切换状态栏图标颜色
    // 深色主题用白色图标(默认), 浅色主题用深色图标, 保证透明状态栏上始终可见
    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        android.content.Context ctx = view.getContext();
        if (!(ctx instanceof Activity)) return;
        Window win = ((Activity) ctx).getWindow();
        if (win == null) return;
        view.evaluateJavascript(
            "document.documentElement.getAttribute('data-theme')==='light'?'1':'0'",
            value -> {
                boolean lightTheme = "\"1\"".equals(value);
                // 用平台 API 而非 androidx.core: 部分镜像的 core AAR 缺少新命名方法
                android.view.View decor = win.getDecorView();
                int vis = decor.getSystemUiVisibility();
                if (lightTheme) vis |= android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                else vis &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                decor.setSystemUiVisibility(vis);
            });
    }
}
