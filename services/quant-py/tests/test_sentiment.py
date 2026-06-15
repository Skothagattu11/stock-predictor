import httpx
from app.data.news_sentiment import NewsSentiment

def _client(items):
    def handler(request): return httpx.Response(200, json=items)
    return httpx.Client(transport=httpx.MockTransport(handler))

def test_positive_headlines_score_positive():
    items = [{"headline": "Company beats earnings, record growth and upgrade",
              "summary": "strong rally", "url": "u1"},
             {"headline": "Analysts raise target on strong demand", "summary": "", "url": "u2"}]
    s = NewsSentiment(api_key="k", http=_client(items)).fetch_sentiment("AAPL")
    assert s.label == "positive" and s.score > 0 and s.headline_count == 2

def test_negative_headlines_score_negative():
    items = [{"headline": "Stock plunges on earnings miss and downgrade", "summary": "weak", "url": "u"}]
    s = NewsSentiment(api_key="k", http=_client(items)).fetch_sentiment("AAPL")
    assert s.label == "negative" and s.score < 0

def test_no_news_is_neutral():
    s = NewsSentiment(api_key="k", http=_client([])).fetch_sentiment("AAPL")
    assert s.label == "neutral" and s.score == 0.0 and s.headline_count == 0
