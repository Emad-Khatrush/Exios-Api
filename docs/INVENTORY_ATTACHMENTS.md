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

## Private storage

New Inventory files are stored in MongoDB GridFS in `inventoryAttachments.files` and `inventoryAttachments.chunks`. They are durable database objects, not dyno-local files, and have no public cloud URL. Upload streams finish before attachment metadata is committed. Failed requests clean up newly created objects when possible. An interrupted process may leave an unreferenced GridFS object; maintenance must only remove confirmed unreferenced objects.

Metadata stores `storageKind`, `storageId`, `originalName`, `visibility`, `uploadedBy` and the existing filename/size/type fields. API responses expose only display metadata for files visible to the requesting role. They do not expose raw storage IDs, public paths or pending cloud cleanup paths. Embedded trip data on order/customer endpoints excludes trip attachments entirely.

Content is downloaded through an authenticated endpoint that checks the current user role. Responses use `private, no-store`, `nosniff` and attachment disposition. The frontend retrieves a Blob with its authenticated request rather than placing bearer tokens in URLs. Database backups made with the existing full `mongodump` include both GridFS collections; restores must retain them together with Inventory metadata.

## Existing public cloud files

Old files remain visible to all staff and can be downloaded through the authenticated Inventory endpoint. Their original public storage objects are retained until a manager requests restricted access.

Before restricting such a file, the server copies it to GridFS and records its original cloud path as an internal pending-cleanup field. Visibility remains unchanged until deletion of the old public object succeeds. If cloud access/deletion fails, the request reports the problem and does not claim to have restricted the file. Retrying completes the cleanup using the saved private copy. This requires the existing cloud credentials to have read/delete access to that object. Unsupported old URLs or oversized legacy files require a supported private replacement.

After successful removal of the old object, the visibility update and audit event are committed together. Making the file visible to all staff again changes access only; it does not make the private object public. Previously downloaded copies cannot be recalled by changing access.

## Routes

- `POST /api/inventory`: create a trip, optionally including files and `attachmentVisibilities` as a JSON array aligned with multipart file order.
- `POST /api/inventory/uploadFiles`: add files to an existing trip; `id` identifies the trip.
- `GET /api/inventory/:id/attachments/:attachmentId/content`: authorized download.
- `PUT /api/inventory/:id/attachments/:attachmentId/visibility`: manager-only visibility update with `{ "visibility": "staff" }` or `{ "visibility": "management" }`.
- `DELETE /api/inventory/deleteFiles`: manager-only removal by `id` and `attachmentId`; old `image._id`/`image.filename` selectors remain accepted.

Generic trip updates reject direct changes to `attachments`; permissions cannot be bypassed by submitting a replacement attachment array. Upload, visibility change and delete actions are recorded in the activity log. This feature does not post financial journal entries.
