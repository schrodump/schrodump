-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFailureAt" TIMESTAMP(3),
    "lastFailure" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationState" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSnapshot" (
    "organizationId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "unobserved" INTEGER NOT NULL,
    CONSTRAINT "NotificationSnapshot_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE INDEX "NotificationChannel_organizationId_idx" ON "NotificationChannel"("organizationId");
CREATE INDEX "NotificationState_organizationId_idx" ON "NotificationState"("organizationId");
CREATE UNIQUE INDEX "NotificationState_organizationId_trigger_key_key" ON "NotificationState"("organizationId", "trigger", "key");

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationState" ADD CONSTRAINT "NotificationState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationSnapshot" ADD CONSTRAINT "NotificationSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
