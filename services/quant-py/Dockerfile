FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e .
COPY app ./app
EXPOSE 8000
# Shell form so Render's injected $PORT is honored; defaults to 8000 locally.
CMD uvicorn app.api:app --host 0.0.0.0 --port ${PORT:-8000}
