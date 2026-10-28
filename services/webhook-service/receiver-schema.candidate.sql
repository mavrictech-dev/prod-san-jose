-- Reference consumer-owned synthetic DB only, not a business integration migration.
CREATE TABLE "WebhookReceiverInbox" ("eventId" uuid PRIMARY KEY,"deliveryId" uuid NOT NULL UNIQUE,"bodySha256" char(64) NOT NULL,"payload" jsonb NOT NULL,"receivedAt" timestamptz NOT NULL DEFAULT now());
