FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 911 appgroup \
    && useradd -u 911 -g appgroup -s /sbin/nologin -M appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY templates/ templates/
COPY static/ static/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && chown -R appuser:appgroup /app

EXPOSE 5000

ENTRYPOINT ["/entrypoint.sh"]
