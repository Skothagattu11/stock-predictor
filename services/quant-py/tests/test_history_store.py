import pandas as pd
from app.store.history import HistoryStore

def _bars(ts):
    return pd.DataFrame({"timestamp": ts, "open": [1.0]*len(ts), "high": [1.0]*len(ts),
                         "low": [1.0]*len(ts), "close": [1.0]*len(ts), "volume": [10.0]*len(ts)})

def test_append_and_info(tmp_path):
    h = HistoryStore(str(tmp_path))
    h.append("AAPL", _bars([1, 2, 3]))
    info = h.info("AAPL")
    assert info["rows"] == 3

def test_append_dedups_by_timestamp(tmp_path):
    h = HistoryStore(str(tmp_path))
    h.append("AAPL", _bars([1, 2, 3]))
    h.append("AAPL", _bars([3, 4, 5]))     # 3 overlaps
    assert h.info("AAPL")["rows"] == 5      # 1,2,3,4,5

def test_info_empty_symbol(tmp_path):
    assert HistoryStore(str(tmp_path)).info("NONE")["rows"] == 0
