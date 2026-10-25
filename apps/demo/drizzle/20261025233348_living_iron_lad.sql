CREATE TABLE "access_grant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" text NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"organization_id" uuid,
	"email" text,
	"level" smallint NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grant_once" UNIQUE NULLS NOT DISTINCT("item_kind","item_id","user_id","team_id","organization_id","email"),
	CONSTRAINT "access_grant_one_grantee" CHECK (num_nonnulls("access_grant"."user_id", "access_grant"."team_id", "access_grant"."organization_id", "access_grant"."email") = 1),
	CONSTRAINT "access_grant_level" CHECK ("access_grant"."level" between 1 and 5),
	CONSTRAINT "access_grant_email_lower" CHECK ("access_grant"."email" = lower("access_grant"."email"))
);
--> statement-breakpoint
CREATE TABLE "access_item" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"parent_kind" text NOT NULL,
	"parent_id" text NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_item_kind_id_pk" PRIMARY KEY("kind","id"),
	CONSTRAINT "access_item_kind" CHECK ("access_item"."kind" not in ('user', 'organization'))
);
--> statement-breakpoint
CREATE TABLE "access_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"level" smallint NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "access_link_level" CHECK ("access_link"."level" between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_item_fk" FOREIGN KEY ("item_kind","item_id") REFERENCES "public"."access_item"("kind","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_link" ADD CONSTRAINT "access_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_link" ADD CONSTRAINT "access_link_item_fk" FOREIGN KEY ("item_kind","item_id") REFERENCES "public"."access_item"("kind","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_user_idx" ON "access_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_grant_team_idx" ON "access_grant" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "access_grant_organization_idx" ON "access_grant" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "access_grant_email_idx" ON "access_grant" USING btree ("email");--> statement-breakpoint
CREATE INDEX "access_item_parent_idx" ON "access_item" USING btree ("parent_kind","parent_id");--> statement-breakpoint
CREATE INDEX "access_link_item_idx" ON "access_link" USING btree ("item_kind","item_id");