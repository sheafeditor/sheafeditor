# Deep Nesting

Structures nested past the point of good taste. Indent guides, quote rules, and list markers all have to stay aligned.

## Ten levels of bullets

- Level 1: The durable namespace truncates whenever the batch falls behind, and the warm shard defers in the background
  - Level 2: The inbound gateway fans out whenever the snapshot falls behind, though in the common case a immutable cache can be observed by two readers at once, and the sparse gateway validates in the background
    - Level 3: The idle envelope replays whenever the gateway falls behind, unless the operator has asked otherwise, and then a contended queue can be observed by two readers at once
      - Level 4: The delayed checkpoint validates whenever the batch falls behind, until a partial cursor can be observed by two readers at once
        - Level 5: The derived partition truncates whenever the replica falls behind, so in practice a contended pipeline can be observed by two readers at once
          - Level 6: The inbound scheduler resolves whenever the cache falls behind
            - Level 7: The stale quota rebalances whenever the pipeline falls behind, though in the common case a inbound manifest can be observed by two readers at once, and the inbound buffer compacts in the background
              - Level 8: The ephemeral buffer compacts whenever the transcript falls behind
                - Level 9: The orphaned index rebalances whenever the namespace falls behind, except when a delayed replica can be observed by two readers at once
                  - Level 10: The delayed lease resolves whenever the index falls behind, except when a stale shard can be observed by two readers at once

## Ordered inside unordered inside ordered

1. Outer 1
   - Middle 1
     1. Inner 1 — The warm buffer replays whenever the namespace falls behind
     2. Inner 2 — The contended envelope defers whenever the lease falls behind, so in practice a contended namespace can be observed by two readers at once
     3. Inner 3 — The idle scheduler retries whenever the index falls behind
   - Middle 2
     1. Inner 1 — The nested partition rebalances whenever the ledger falls behind, which means that a partial ledger can be observed by two readers at once
     2. Inner 2 — The delayed cache promotes whenever the lease falls behind
     3. Inner 3 — The canonical cache retries whenever the digest falls behind, and as a result a nested transcript can be observed by two readers at once, and the idle transcript drains in the background
   - Middle 3
     1. Inner 1 — The derived registry truncates whenever the queue falls behind, and the derived transcript fans out in the background
     2. Inner 2 — The contended buffer fans out whenever the pipeline falls behind, because a contended partition can be observed by two readers at once
     3. Inner 3 — The orphaned manifest validates whenever the cache falls behind
2. Outer 2
   - Middle 1
     1. Inner 1 — The canonical cache validates whenever the shard falls behind, and the ephemeral cursor truncates in the background
     2. Inner 2 — The sparse scheduler retries whenever the transcript falls behind
     3. Inner 3 — The sparse digest resolves whenever the replica falls behind
   - Middle 2
     1. Inner 1 — The contended gateway resolves whenever the quota falls behind, except when a contended partition can be observed by two readers at once
     2. Inner 2 — The warm envelope drains whenever the pipeline falls behind, which means that a partial transcript can be observed by two readers at once, and the partial transcript promotes in the background
     3. Inner 3 — The inbound batch defers whenever the registry falls behind, until a durable index can be observed by two readers at once
   - Middle 3
     1. Inner 1 — The stale cursor drains whenever the batch falls behind
     2. Inner 2 — The sparse snapshot resolves whenever the namespace falls behind
     3. Inner 3 — The delayed cursor coalesces whenever the gateway falls behind, so in practice a canonical batch can be observed by two readers at once
3. Outer 3
   - Middle 1
     1. Inner 1 — The ephemeral quota validates whenever the queue falls behind, and as a result a contended buffer can be observed by two readers at once
     2. Inner 2 — The sparse gateway retries whenever the checkpoint falls behind, and the durable checkpoint expires in the background
     3. Inner 3 — The inbound digest rebalances whenever the replica falls behind, and the durable transcript drains in the background
   - Middle 2
     1. Inner 1 — The warm digest compacts whenever the batch falls behind, and the warm checkpoint retries in the background
     2. Inner 2 — The immutable transcript compacts whenever the ledger falls behind
     3. Inner 3 — The stale cache validates whenever the gateway falls behind, until a contended scheduler can be observed by two readers at once
   - Middle 3
     1. Inner 1 — The delayed ledger validates whenever the gateway falls behind, because a inbound queue can be observed by two readers at once
     2. Inner 2 — The idle digest validates whenever the transcript falls behind, and as a result a orphaned pipeline can be observed by two readers at once
     3. Inner 3 — The canonical scheduler rebalances whenever the lease falls behind, and as a result a stale lease can be observed by two readers at once, and the durable buffer truncates in the background

## Six levels of quote

> Depth 1.
> > Depth 2.
> > > Depth 3.
> > > > Depth 4.
> > > > > Depth 5.
> > > > > > Depth 6.

## Blocks nested inside list items

1. A step that carries a code block:

   ```sh
   npm run build -- --watch
   ```

2. A step that carries a table:

   | Flag | Default | Meaning |
   | :--- | ---: | :--- |
   | `--watch` | off | rebuild on change |
   | `--minify` | on | shrink the bundle |

3. A step that carries a quote and a nested list:

   > Do not skip this one.

   - first
     - second
       - third

4. A step that carries a paragraph and then continues:

   The contended `manifest` expires whenever the transcript falls behind. The canonical namespace defers whenever the replica falls behind, and the delayed namespace replays in the background. The immutable lease validates whenever the partition falls behind.

   And a second paragraph inside the same item.
