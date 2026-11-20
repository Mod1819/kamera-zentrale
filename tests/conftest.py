import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(scope="session", autouse=True)
def _pycares_thread():
    """pycares startet seinen Shutdown-Thread beim ersten DNS-Channel; sonst meldet verify_cleanup ihn als Leak."""
    try:
        import pycares

        pycares._shutdown_manager.start()
    except (ImportError, AttributeError):
        pass
    yield
