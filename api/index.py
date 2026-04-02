import os
import psycopg2
from fastapi import FastAPI

app = FastAPI()

def get_conn():
    # Ambil URL koneksi database dari variabel lingkungan
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise Exception("DATABASE_URL belum ada")
    
    # Menghubungkan ke Supabase (PostgreSQL)
    return psycopg2.connect(database_url)

@app.get("/api/health")
def health():
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT 1;")
        cur.fetchone()
        cur.close()
        conn.close()

        return {
            "ok": True,
            "message": "Backend hidup dan database tersambung"
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e)
        }