# testdata/

真实安装结果与评测基线的数据目录（不入库运行时产物，只入库脚本/约定）。

- `ground-truth/` —— 方案 §13 的 Ground Truth Docker matrix。
  详细用法见该目录下的 [`README.md`](./ground-truth/README.md)：
  编译器 wrapper 采集 + Node{20,22,24}×libc{glibc,musl} Docker matrix + L1/L2/L3 四格表。

> 没有测量就没有改善 —— 这是最容易被跳过、但最关键的一步。
