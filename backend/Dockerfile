FROM python:3.11-slim

# System deps needed by Pillow (and later, torch)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first — Docker caches this layer, so code changes
# don't trigger a full reinstall
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

# Persistent process, NOT serverless. This is what makes the API
# portable across Render, Railway, Hugging Face Spaces, or a VM.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]