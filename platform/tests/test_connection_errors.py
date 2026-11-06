import ssl

import pytest
from alcor_api.connection_errors import connection_failure_message
from redis import exceptions as redis_errors


@pytest.mark.parametrize(
    "exception,expected",
    [
        (redis_errors.AuthenticationError, "认证失败"),
        (redis_errors.NoPermissionError, "ACL拒绝"),
        (redis_errors.TimeoutError, "超时"),
        (TimeoutError, "超时"),
        (redis_errors.ConnectionError, "无法建立"),
        (redis_errors.ResponseError, "协议错误"),
        (ssl.SSLError, "TLS握手失败"),
        (ssl.SSLCertVerificationError, "证书验证失败"),
        (RuntimeError, "连接检查失败"),
    ],
)
def test_diagnostics_classify_types_without_exposing_provider_secrets(exception, expected):
    secret = "SyntheticPrivateCredential9"
    message = connection_failure_message("redis", exception(secret))
    assert expected in message and secret not in message
    assert (
        connection_failure_message("postgresql", exception(secret))
        == "连接失败，请核对地址、账号、密码和连接权限"
    )


def test_wrapped_tls_failure_is_not_misreported_as_network_or_authentication_failure():
    failure = redis_errors.ConnectionError("SyntheticPrivateTarget")
    failure.__cause__ = ssl.SSLCertVerificationError("SyntheticCertificateDetail")
    message = connection_failure_message("redis", failure)
    assert "证书验证失败" in message and "Synthetic" not in message
    failure.__cause__ = failure
    assert "无法建立" in connection_failure_message("redis", failure)


def test_wrapped_authentication_and_acl_errors_keep_their_original_category():
    for cause, expected in [
        (redis_errors.AuthenticationError("SyntheticCredential"), "认证失败"),
        (redis_errors.NoPermissionError("SyntheticAclDetail"), "ACL拒绝"),
    ]:
        error = redis_errors.ConnectionError("SyntheticTransportDetail")
        error.__cause__ = cause
        message = connection_failure_message("redis", error)
        assert expected in message and "Synthetic" not in message


@pytest.mark.parametrize(
    "system_error,expected",
    [
        (__import__("errno").EPERM, "本机系统拒绝"),
        (__import__("errno").EACCES, "本机系统拒绝"),
        (__import__("errno").ECONNREFUSED, "目标端口拒绝"),
        (__import__("errno").EHOSTUNREACH, "无法路由"),
        (__import__("errno").ENETUNREACH, "无法路由"),
    ],
)
def test_process_network_restrictions_are_distinct_from_credentials_and_routing(system_error, expected):
    error = redis_errors.ConnectionError("SyntheticProviderDetails")
    error.__cause__ = OSError(system_error, "SyntheticSystemDetails")
    message = connection_failure_message("redis", error)
    assert expected in message and "Synthetic" not in message
