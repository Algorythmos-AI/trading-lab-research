"""D6: two processes sharing the limiter file never exceed the global cap together."""
import multiprocessing as mp
import time

from wt.data.alpaca import SharedRateLimiter


def _worker(path, n, out):
    rl = SharedRateLimiter(path, global_per_minute=10, own_per_minute=1000)
    stamps = []
    for _ in range(n):
        rl.wait()
        stamps.append(time.time())
    out.put(stamps)


def test_shared_cap_across_processes(tmp_path):
    path = tmp_path / "rate.json"
    q = mp.Queue()
    ps = [mp.Process(target=_worker, args=(str(path), 5, q)) for _ in range(2)]
    t0 = time.time()
    for p in ps:
        p.start()
    stamps = sorted(q.get(timeout=30) + q.get(timeout=30))
    for p in ps:
        p.join(timeout=30)
    assert len(stamps) == 10 and all(s - t0 < 5 for s in stamps)      # 10 calls fit in one window: no waiting
    rl = SharedRateLimiter(path, global_per_minute=10, own_per_minute=1000)
    t1 = time.time()
    import threading
    done = threading.Event()
    threading.Thread(target=lambda: (rl.wait(), done.set()), daemon=True).start()
    assert not done.wait(1.0)                                          # the 11th call within 60 s must block
    assert time.time() - t1 >= 1.0
