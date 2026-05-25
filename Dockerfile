FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
COPY templates/ templates/
COPY static/ static/

EXPOSE 5000

CMD ["gunicorn", "--config", "gunicorn.conf.py", "app:app"]
