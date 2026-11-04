# The rail letter travels as `NetIfInfo.rail`

The RDMA and NCCL benchmarks need to know which interconnect is rail A and which is rail B. The agent decides this at start: the interconnects whose link is up get the letters A and B in PCI order, and the other ports are spares. We send that letter as an optional field, `NetIfInfo.rail`, which is null for a spare port. Spec #6 lists only `NetIfInfo.nic_model` as a new wire field. #9 adds `rail` as well, for the reasons below.

Before this field, the console found a rail by matching the label text ("ConnectX-7 rail A"). A relabelled NIC broke the benchmarks, and the label now names no NIC model.

## Considered options

- **A distinct `role` value**, such as a separate role for a lettered interconnect. `role` is a closed set of values, so an older console fails to parse the new value and rejects the whole node.
- **A positional rule**, where the first interconnect in the list is rail A and the second is rail B. The list does not say which ports were up at agent start. That rule gave spare ports the letters C and D, and made a spare port rail A when no link was up.

An optional field is additive on the wire. An older console ignores it, and `SCHEMA_VERSION` stays 1.

## Older agents

Older agents send no `rail`. When `NetIfInfo` parses such a payload at the console boundary, it takes the letter from a label that ends in "rail X", the console's old rule. That validator is the only code that reads rail letters from label text.
