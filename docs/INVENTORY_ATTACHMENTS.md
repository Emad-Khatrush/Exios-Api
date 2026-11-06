# Inventory attachment access

Local implementation, 24 October 2026. This document does not confirm a QA or production deployment.

## Visibility and roles

The shared `ImageUploader` enables attachment permissions only when its `inventoryFileAccess` prop is supplied. Inventory create/edit uses this opt-in mode; the rest of the app retains its current upload behavior.

Each Inventory file has one of two visibility values:

- `staff` — **All staff**: employees, admins and accountants.
- `management` — **Admin & accountant only**: users with `roles.isAdmin` or `roles.isAccountant`.

Old files without a visibility field are treated as `staff`, as requested. There is no bulk migration that restricts old attachments. An admin or accountant can change an individual old file later.

Admins and accountants choose the default visibility before uploading, adjust individual pending files while creating a trip, and change saved files from either the summary or edit view. Employees can upload files visible to all staff and download files available to them; they cannot change visibility, upload restricted files, or delete attachments. Server checks apply independently of visible UI controls.

Any file type is accepted, up to 25 MB per file and 20 files per upload. Original names, MIME types and byte sizes are preserved. Safe image formats can be previewed; other types can be downloaded.

## Storage

Since 6 November 2026 new Inventory files are uploaded to the company's Google bucket (`GOOGLE_BUCKET_ID`), like the other uploads, under `inventory-files/<random uuid>` (`storageKind: 'google'`). Before that they were kept in MongoDB GridFS (`inventoryAttachments.files`/`.chunks`), so every daily database backup carried them again; `node scripts/moveInventoryFilesToGoogle.js` lists those files and, with `--apply`, moves them to the bucket and removes them from GridFS. QA never writes to the live bucket: there files still go to QA's own GridFS.

The bucket is readable by link, so access rests on the link never reaching the browser: API responses expose only display metadata (name, type, size, visibility) for files visible to the requesting role, never the storage path, and object names are random. Content is downloaded through an authenticated endpoint that checks the current user role, with `private, no-store`, `nosniff` and attachment disposition. The frontend retrieves a Blob with its authenticated request rather than placing bearer tokens in URLs. Embedded trip data on order/customer endpoints excludes trip attachments entirely.

Changing a file's visibility only changes that field; the file is not moved. Deleting a file removes its Google object (only objects this feature created; older shared uploads are left in place). Previously downloaded copies cannot be recalled by changing access.

## Routes

- `POST /api/inventory`: create a trip, optionally including files and `attachmentVisibilities` as a JSON array aligned with multipart file order.
- `POST /api/inventory/uploadFiles`: add files to an existing trip; `id` identifies the trip.
- `GET /api/inventory/:id/attachments/:attachmentId/content`: authorized download.
- `PUT /api/inventory/:id/attachments/:attachmentId/visibility`: manager-only visibility update with `{ "visibility": "staff" }` or `{ "visibility": "management" }`.
- `DELETE /api/inventory/deleteFiles`: manager-only removal by `id` and `attachmentId`; old `image._id`/`image.filename` selectors remain accepted.

Generic trip updates reject direct changes to `attachments`; permissions cannot be bypassed by submitting a replacement attachment array. Upload, visibility change and delete actions are recorded in the activity log. This feature does not post financial journal entries.
