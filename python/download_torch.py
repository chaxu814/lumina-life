import urllib.request, os, sys

url = "https://download.pytorch.org/whl/cu128/torch-2.7.0%2Bcu128-cp310-cp310-win_amd64.whl"
out = r"C:\Users\13510\torch_cu128.whl"

print(f"Downloading {url} -> {out}")

def report(count, block_size, total_size):
    pct = count * block_size * 100.0 / total_size if total_size > 0 else 0
    sys.stdout.write(f"\r{pct:.1f}% ({count*block_size/1024/1024:.0f} MB)")
    sys.stdout.flush()

urllib.request.urlretrieve(url, out, report)
print(f"\nDone: {os.path.getsize(out)/1024/1024/1024:.1f} GB")
