import math
import httpx
from app.data.yahoo_options import YahooOptions

def _payload():
    return {"optionChain": {"result": [{
        "quote": {"regularMarketPrice": 200.0},
        "expirationDates": [1750464000],
        "options": [{
            "expirationDate": 1750464000,
            "calls": [{"strike": 195.0, "impliedVolatility": 0.30},
                      {"strike": 200.0, "impliedVolatility": 0.25},
                      {"strike": 205.0, "impliedVolatility": 0.28}],
            "puts":  [{"strike": 200.0, "impliedVolatility": 0.27}],
        }],
    }]}}

def _client():
    def handler(request): return httpx.Response(200, json=_payload())
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_implied_move_uses_atm_iv_and_brackets_spot():
    opt = YahooOptions(http=_client(), now_epoch=1750464000 - 9 * 86400)  # 9 days out
    im = opt.fetch_implied_move("AAPL")
    assert im.spot == 200.0
    assert 0.24 <= im.atm_iv <= 0.27          # avg of nearest-strike call/put IV
    assert im.days_to_expiry == 9
    expected = 200.0 * im.atm_iv * math.sqrt(9 / 365)
    assert abs(im.expected_move_abs - expected) < 0.5
    assert im.low < 200.0 < im.high
