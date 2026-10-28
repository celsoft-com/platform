CREATE TABLE "access_ancestor" (
	"point_id" text NOT NULL,
	"ancestor_id" text NOT NULL,
	"depth" smallint NOT NULL,
	CONSTRAINT "access_ancestor_point_id_ancestor_id_pk" PRIMARY KEY("point_id","ancestor_id")
);
--> statement-breakpoint
ALTER TABLE "access_ancestor" ADD CONSTRAINT "access_ancestor_point_id_access_point_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."access_point"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_ancestor" ADD CONSTRAINT "access_ancestor_ancestor_id_access_point_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."access_point"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_ancestor_ancestor_idx" ON "access_ancestor" USING btree ("ancestor_id");--> statement-breakpoint
CREATE INDEX "access_grant_point_user_idx" ON "access_grant" USING btree ("point_id","user_id") WHERE "access_grant"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "access_grant_point_team_idx" ON "access_grant" USING btree ("point_id","team_id") WHERE "access_grant"."team_id" is not null;--> statement-breakpoint
CREATE INDEX "access_grant_point_organization_idx" ON "access_grant" USING btree ("point_id","organization_id") WHERE "access_grant"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "access_grant_point_email_idx" ON "access_grant" USING btree ("point_id","email") WHERE "access_grant"."email" is not null;--> statement-breakpoint
CREATE INDEX "access_grant_point_everyone_idx" ON "access_grant" USING btree ("point_id") WHERE "access_grant"."everyone";