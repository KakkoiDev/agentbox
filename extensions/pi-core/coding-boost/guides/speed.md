---
triggers: slow, too slow, faster, fast enough, speed, speed up, performance, times out, time limit, timeout, efficient, large input, large inputs
---
A speed fix: the given tests are often much smaller than real inputs, so passing them does not prove the code is fast.
Name the cost of every step in terms of the input size, including work hidden in library calls, sort keys and
membership or search operations inside loops, and remove anything slower than about n log n. Keep the results
identical (ties, order, edge cases). Then time the code with bash on an input at least 10 times larger than the
biggest test, with many distinct values, and report the seconds.
