ALTER TABLE "access_item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "access_item" CASCADE;--> statement-breakpoint
ALTER TABLE "access_grant" DROP CONSTRAINT "access_grant_once";--> statement-breakpoint
ALTER TABLE "team_member" DROP CONSTRAINT "team_member_membership_key_unique";--> statement-breakpoint
ALTER TABLE "access_grant" DROP CONSTRAINT "access_grant_one_grantee";--> statement-breakpoint
ALTER TABLE "access_grant" DROP CONSTRAINT IF EXISTS "access_grant_item_fk";
--> statement-breakpoint
ALTER TABLE "access_link" DROP CONSTRAINT IF EXISTS "access_link_item_fk";
--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_inviter_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "access_link_item_idx";--> statement-breakpoint
DROP INDEX "invitation_organization_id_idx";--> statement-breakpoint
DROP INDEX "member_organization_id_idx";--> statement-breakpoint
DROP INDEX "team_member_team_id_idx";--> statement-breakpoint
ALTER TABLE "access_grant" ALTER COLUMN "point_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_link" ALTER COLUMN "point_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "inviter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_point_idx" ON "access_grant" USING btree ("point_id");--> statement-breakpoint
CREATE INDEX "access_link_point_idx" ON "access_link" USING btree ("point_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_one_admins" ON "team" USING btree ("organization_id") WHERE "team"."admins";--> statement-breakpoint
ALTER TABLE "access_grant" DROP COLUMN "item_kind";--> statement-breakpoint
ALTER TABLE "access_grant" DROP COLUMN "item_id";--> statement-breakpoint
ALTER TABLE "access_link" DROP COLUMN "item_kind";--> statement-breakpoint
ALTER TABLE "access_link" DROP COLUMN "item_id";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "member" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "logo";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_organization_id";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_team_id";--> statement-breakpoint
ALTER TABLE "team" DROP COLUMN "member_count";--> statement-breakpoint
ALTER TABLE "team_member" DROP COLUMN "membership_key";--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_once" UNIQUE NULLS NOT DISTINCT("point_id","user_id","team_id","organization_id","everyone","email");--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_once" UNIQUE("organization_id","email");--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_once" UNIQUE("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_once" UNIQUE("team_id","user_id");--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_everyone" CHECK ("access_grant"."everyone" is null or ("access_grant"."everyone" and "access_grant"."level" = 1));--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_one_grantee" CHECK (num_nonnulls("access_grant"."user_id", "access_grant"."team_id", "access_grant"."organization_id", "access_grant"."everyone", "access_grant"."email") = 1);--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_email_lower" CHECK ("invitation"."email" = lower("invitation"."email"));