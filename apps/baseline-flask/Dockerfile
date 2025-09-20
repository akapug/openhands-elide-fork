# Flask baseline (gunicorn)
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8083
CMD ["python", "-m", "gunicorn", "app.main:app", "-w", "1", "-b", "0.0.0.0:8083"]

