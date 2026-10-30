ALTER TABLE "access_grant" DROP CONSTRAINT "access_grant_once";--> statement-breakpoint
ALTER TABLE "access_grant" DROP CONSTRAINT "access_grant_one_grantee";--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "owner" boolean;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_once" UNIQUE NULLS NOT DISTINCT("point_id","user_id","team_id","organization_id","everyone","owner","email");--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_owner" CHECK ("access_grant"."owner" is null or "access_grant"."owner");--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_one_grantee" CHECK (num_nonnulls("access_grant"."user_id", "access_grant"."team_id", "access_grant"."organization_id", "access_grant"."everyone", "access_grant"."owner", "access_grant"."email") = 1);