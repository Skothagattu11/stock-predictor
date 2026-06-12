from datetime import datetime
from zoneinfo import ZoneInfo
from app.predictors.setups import session_phase

ET = ZoneInfo("America/New_York")
def _epoch(h, m): return int(datetime(2026, 6, 12, h, m, tzinfo=ET).timestamp())

def test_phases():
    assert session_phase(_epoch(9, 45)) == ("open_drive", "high")
    assert session_phase(_epoch(11, 0)) == ("morning", "medium")
    assert session_phase(_epoch(12, 30)) == ("midday", "low")
    assert session_phase(_epoch(14, 0)) == ("afternoon", "medium")
    assert session_phase(_epoch(15, 30)) == ("power_hour", "high")
    assert session_phase(_epoch(8, 0)) == ("pre", "none")
    assert session_phase(_epoch(16, 30)) == ("closed", "none")
