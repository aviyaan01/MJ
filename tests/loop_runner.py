# tests/loop_runner.py
import os
import sys
from pathlib import Path
import unittest

# Ensure workspace root is in sys.path
root_dir = str(Path(__file__).resolve().parent.parent)
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

def run_loop(iterations: int = 3):
    print(f"==================================================")
    print(f"  STARTING UNIT TEST LOOP ({iterations} ITERATIONS)")
    print(f"==================================================")

    all_passed = True
    for i in range(1, iterations + 1):
        print(f"\n--- [ITERATION {i}/{iterations}] ---")
        loader = unittest.TestLoader()
        suite = loader.discover(start_dir="tests", pattern="test_*.py", top_level_dir=root_dir)
        runner = unittest.TextTestRunner(verbosity=1)
        result = runner.run(suite)
        if not result.wasSuccessful():
            print(f"[FAIL] Iteration {i} failed with {len(result.failures)} failures and {len(result.errors)} errors.")
            all_passed = False
            break
        print(f"[PASS] Iteration {i} completed: {result.testsRun} tests passed (0 failures, 0 errors).")

    if all_passed:
        print(f"\n==================================================")
        print(f"  ALL {iterations} LOOPS PASSED PERFECTLY (100% STABLE)!")
        print(f"==================================================")
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    run_loop(count)
