import PyPDF2, os

months = ["february", "march", "april", "may", "june", "july"]
for m in months:
    path = os.path.join("logbook", f"{m}.pdf")
    out_path = os.path.join("logbook", f"{m}_extracted.txt")
    try:
        with open(path, "rb") as f:
            r = PyPDF2.PdfReader(f)
            text = ""
            for i, p in enumerate(r.pages):
                text += f"\n----- PAGE {i+1} -----\n"
                t = p.extract_text()
                text += t if t else "[NO TEXT EXTRACTED]"
        with open(out_path, "w", encoding="utf-8") as o:
            o.write(text)
        print(f"OK {m}: {len(r.pages)} pages -> {out_path}")
    except Exception as e:
        print(f"FAIL {m}: {e}")
