CREATE TABLE "access_point" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"organization_id" uuid,
	"for_organization" uuid,
	"for_team" uuid,
	"inherits" boolean DEFAULT false NOT NULL,
	"static" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_point_for_organization_unique" UNIQUE("for_organization"),
	CONSTRAINT "access_point_for_team_unique" UNIQUE("for_team"),
	CONSTRAINT "access_point_id" CHECK (length("access_point"."id") between 1 and 200),
	CONSTRAINT "access_point_not_own_parent" CHECK ("access_point"."parent_id" is distinct from "access_point"."id"),
	CONSTRAINT "access_point_organization_id" CHECK (("access_point"."for_organization" is not null) = ("access_point"."id" like 'organization:%')),
	CONSTRAINT "access_point_team_id" CHECK (("access_point"."for_team" is not null) = ("access_point"."id" like 'team:%'))
);
--> statement-breakpoint
ALTER TABLE "access_grant" ALTER COLUMN "item_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grant" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_link" ALTER COLUMN "item_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_link" ALTER COLUMN "item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "point_id" text;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "everyone" boolean;--> statement-breakpoint
ALTER TABLE "access_link" ADD COLUMN "point_id" text;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "admins" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "access_point" ADD CONSTRAINT "access_point_parent_id_access_point_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."access_point"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_point" ADD CONSTRAINT "access_point_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_point" ADD CONSTRAINT "access_point_for_organization_organization_id_fk" FOREIGN KEY ("for_organization") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_point" ADD CONSTRAINT "access_point_for_team_team_id_fk" FOREIGN KEY ("for_team") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_point" ADD CONSTRAINT "access_point_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_point_parent_idx" ON "access_point" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "access_point_organization_idx" ON "access_point" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_point_id_access_point_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."access_point"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_link" ADD CONSTRAINT "access_link_point_id_access_point_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."access_point"("id") ON DELETE cascade ON UPDATE no action;