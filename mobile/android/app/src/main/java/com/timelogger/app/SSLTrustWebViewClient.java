package com.timelogger.app;

import android.webkit.SslErrorHandler;
import android.webkit.WebView;
import android.net.http.SslError;
import android.webkit.WebViewClient;
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
}
