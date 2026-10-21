-- A customer that is a unit in a special economic zone: its supplies are always inter-state (IGST) and are reported
-- on the e-invoice as an SEZ supply type.
ALTER TABLE "Customer" ADD COLUMN "isSez" BOOLEAN NOT NULL DEFAULT false;
