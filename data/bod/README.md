# data/bod/ — manual exchange drops

Put manually downloaded exchange files here — NSE/BSE **bhavcopies** and daily
reports. The pipeline reads them from this folder; it does not fetch them
(NSE/BSE gate bulk downloads behind cookies/captcha, so a manual drop is the
reliable path).

**Naming:** keep the exchange's original filename — it carries the date, which
is the partition key (e.g. `sec_bhavdata_full_17072026.csv`,
`BhavCopy_NSE_CM_0_0_0_20260717_F_0000.csv`).

Contents here are **committed** so the history of what was ingested is part of
the repo. Parsed/derived outputs go to `data/` and `data/csv/`.
