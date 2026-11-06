"""Safe connection diagnostics: classify exception types without echoing provider details."""

import errno
import ssl

from redis import exceptions as redis_errors


def connection_failure_message(kind, error):
    if kind != "redis":
        return "连接失败，请核对地址、账号、密码和连接权限"
    causes = []
    current = error
    for _ in range(5):
        if current is None or any(current is cause for cause in causes):
            break
        causes.append(current)
        current = current.__cause__ or current.__context__
    if any(isinstance(cause, ssl.SSLCertVerificationError) for cause in causes):
        return "Redis TLS证书验证失败，请核对证书信任与主机名"
    if any(isinstance(cause, ssl.SSLError) for cause in causes):
        return "Redis TLS握手失败，请核对TLS开关与服务端端口"
    if any(isinstance(cause, redis_errors.AuthenticationError) for cause in causes):
        return "Redis认证失败，请核对ACL用户名、密码及账号启用状态"
    if any(isinstance(cause, redis_errors.NoPermissionError) for cause in causes):
        return "Redis已响应，但ACL拒绝连接检查命令，请核对PING及连接握手权限"
    if any(isinstance(cause, (TimeoutError, redis_errors.TimeoutError)) for cause in causes):
        return "Redis连接或响应超时，请核对目标端口和网络访问规则"
    system_errors = {cause.errno for cause in causes if isinstance(cause, OSError)}
    if system_errors & {errno.EPERM, errno.EACCES}:
        return "本机系统拒绝Redis网络访问，请检查运行服务的本地网络权限与防火墙"
    if errno.ECONNREFUSED in system_errors:
        return "Redis目标端口拒绝连接，请核对服务监听与端口映射"
    if system_errors & {errno.ENETUNREACH, errno.EHOSTUNREACH}:
        return "本机无法路由到Redis目标，请核对局域网、VPN与路由设置"
    if any(isinstance(cause, (OSError, redis_errors.ConnectionError)) for cause in causes):
        return "无法建立Redis连接，请核对地址、端口和网络访问规则"
    if any(isinstance(cause, redis_errors.ResponseError) for cause in causes):
        return "Redis返回协议错误，请核对服务版本、数据库编号与连接命令权限"
    return "Redis连接检查失败，请核对服务状态与连接配置"
