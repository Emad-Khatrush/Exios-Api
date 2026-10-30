# Daily employee operations and periodic work

The existing `/accounting/daily-work` page now has two top-level tabs:

- Employee operations: today by default, date/employee/office/type/review filters, paginated original documents, accounting links, and individual or selected-row reviews.
- Weekly and periodic work: the existing cash-count, backlog, issue handling and saved reports. These tools remain available on demand. A saved report still describes the chosen accounting day and the backlog at the time of saving; this change does not create a weekly ledger close, lock periods, or schedule recurring tasks.

## Sources and counting

The service reads customer wallet statements, unlinked order payment histories, purchase orders, customer delivery invoices, supplier bills/payments/receipts, customer refunds, treasury transfers, salary/commission payments, yuan purchases, equity/loans, nettings, write-offs, manual journals, saved statement edits/deletions, invoice cancellations, and recorded financial audit changes.

Linked order payments are represented by their wallet statement once. Refund documents supersede their linked wallet credit. Posting journal lines are references on the original operation, not extra operational rows. Invoice creation and invoice payment are distinct events, not interchangeable cash movements.

Counts and per-type/per-currency values cover the entire filtered range, not just the current page. Canceled documents remain visible but do not contribute to the amount summaries. These summaries are operation values, not cash receipts, revenue or profit. Unknown old payment purposes remain generic rather than guessing from the amount alone.

Wallet/payment IDs provide their insertion time, because their editable `createdAt` can be a backdated financial date. The original financial date is shown separately. Other documents use recorded creation/edit/cancellation time. Legacy missing actors show as unknown; missing document offices can fall back to the employee's current office, explicitly labeled as such. Missing legacy audit information is not reconstructed or invented.

## Review integrity and access

GET `daily-work/operations` and GET `daily-work/operations/options` require reports or treasury permission. POST `daily-work/operations/review` requires treasury or closing permission, in addition to the existing accounting membership checks.

Reviews store a document-version fingerprint, state, accountant note, reviewer and timestamp. The current list accepts a review only for the matching version; an edited document returns to pending. Approval of an outdated selection returns HTTP 409. Bulk reviews validate all selected snapshots in one transaction (maximum 100 distinct operations), then save the reviews and audit log together. Review writes do not alter wallet balances, invoices or journal entries.

MongoDB does not allow `$unionWith` inside transactions: listing uses a union and facet, while review validation reads each involved source collection separately in the same transaction with identical normalization rules. Names and codes are returned from user joins; passwords and other private profile fields are excluded.

The periodic tab is mounted only when opened, so its existing checks and backlog requests do not slow the default daily review tab. The daily list loads 30 operations per page and ignores superseded responses when filters change quickly.

## Verification

- `npm test -- --runTestsByPath accounting/tests/employeeOperations.test.js accounting/tests/dailyWork.test.js`
- Frontend `EmployeeOperations.test.tsx`: today's range, quick periods, source links, snapshot/note review submission, and periodic-tab isolation.
- TypeScript and isolated desktop/mobile browser checks, without modifying company data.
