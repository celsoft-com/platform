CREATE TABLE "signup_invite" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_invite_email_unique" UNIQUE("email"),
	CONSTRAINT "signup_invite_email_lower" CHECK ("signup_invite"."email" = lower("signup_invite"."email"))
);
--> statement-breakpoint
ALTER TABLE "signup_invite" ADD CONSTRAINT "signup_invite_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;