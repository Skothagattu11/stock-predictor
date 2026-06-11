import importlib

def test_config_reads_env(monkeypatch):
    monkeypatch.setenv("FRED_API_KEY", "abc")
    monkeypatch.setenv("FMP_API_KEY", "def")
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.FRED_API_KEY == "abc"
    assert cfg.FMP_API_KEY == "def"

def test_config_missing_keys_default_empty(monkeypatch):
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    import app.config as cfg
    importlib.reload(cfg)
    assert cfg.FRED_API_KEY == ""
