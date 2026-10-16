# Split-view

Domain language for the activity displayed alongside the native transcript.

## Language

**Files activity**:
File references observed in tool activity, together with the displayed Last Edit.
A reference does not imply that the tool call succeeded or changed the file.

**Files history**:
The recent file references in Files activity, ordered newest first, with their
read, write, seen, or subagent provenance and occurrence counts.

**Last Edit**:
The edit preview or reported edit diff displayed alongside Files history.
A preview describes an intended edit, not a confirmed filesystem change.
