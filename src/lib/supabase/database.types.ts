
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "account_notices": {
                  Row: {
                    "acknowledged_at": string | null,"created_at": string,"ends_at": string | null,"id": string,"kind": string,"reason": string | null,"sanction_id": string | null,"user_id": string
                  }
                  Insert: {
                    "acknowledged_at"?: string | null,"created_at"?: string,"ends_at"?: string | null,"id"?: string,"kind": string,"reason"?: string | null,"sanction_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "acknowledged_at"?: string | null,"created_at"?: string,"ends_at"?: string | null,"id"?: string,"kind"?: string,"reason"?: string | null,"sanction_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "account_notices_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"blocks": {
                  Row: {
                    "blocked_id": string,"blocker_id": string,"created_at": string
                  }
                  Insert: {
                    "blocked_id": string,"blocker_id": string,"created_at"?: string
                  }
                  Update: {
                    "blocked_id"?: string,"blocker_id"?: string,"created_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "blocks_blocked_id_fkey"
      columns: ["blocked_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "blocks_blocker_id_fkey"
      columns: ["blocker_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"entitlements": {
                  Row: {
                    "created_at": string,"grant_id": string | null,"granted_at": string,"id": string,"item_id": string,"purchase_id": string | null,"revoke_reason": string | null,"revoked_at": string | null,"source": string,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"grant_id"?: string | null,"granted_at"?: string,"id"?: string,"item_id": string,"purchase_id"?: string | null,"revoke_reason"?: string | null,"revoked_at"?: string | null,"source": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"grant_id"?: string | null,"granted_at"?: string,"id"?: string,"item_id"?: string,"purchase_id"?: string | null,"revoke_reason"?: string | null,"revoked_at"?: string | null,"source"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "entitlements_grant_id_fkey"
      columns: ["grant_id"]
isOneToOne: false
      referencedRelation: "grants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entitlements_purchase_id_fkey"
      columns: ["purchase_id"]
isOneToOne: false
      referencedRelation: "purchases"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entitlements_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"friend_boosts": {
                  Row: {
                    "created_at": string,"grant_id": string | null,"id": number,"ny_day": string,"recipient_id": string,"sender_id": string
                  }
                  Insert: {
                    "created_at"?: string,"grant_id"?: string | null,"id"?: never,"ny_day": string,"recipient_id": string,"sender_id": string
                  }
                  Update: {
                    "created_at"?: string,"grant_id"?: string | null,"id"?: never,"ny_day"?: string,"recipient_id"?: string,"sender_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "friend_boosts_grant_id_fkey"
      columns: ["grant_id"]
isOneToOne: false
      referencedRelation: "grants"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "friend_boosts_recipient_id_fkey"
      columns: ["recipient_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "friend_boosts_sender_id_fkey"
      columns: ["sender_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"friendships": {
                  Row: {
                    "addressee_id": string,"created_at": string,"id": string,"requester_id": string,"responded_at": string | null,"status": string,"updated_at": string
                  }
                  Insert: {
                    "addressee_id": string,"created_at"?: string,"id"?: string,"requester_id": string,"responded_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "addressee_id"?: string,"created_at"?: string,"id"?: string,"requester_id"?: string,"responded_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "friendships_addressee_id_fkey"
      columns: ["addressee_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "friendships_requester_id_fkey"
      columns: ["requester_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"grants": {
                  Row: {
                    "applied_at": string | null,"campaign_id": string | null,"cap_amount": number,"cash_amount": number,"clout_amount": number,"clout_cap": number,"created_at": string,"eligibility": NonNullable<Json>,"id": string,"idempotency_key": string,"issued_by": string,"item_id": string | null,"kind": string,"reason": string,"user_id": string
                  }
                  Insert: {
                    "applied_at"?: string | null,"campaign_id"?: string | null,"cap_amount": number,"cash_amount"?: number,"clout_amount"?: number,"clout_cap": number,"created_at"?: string,"eligibility": NonNullable<Json>,"id"?: string,"idempotency_key": string,"issued_by": string,"item_id"?: string | null,"kind": string,"reason": string,"user_id": string
                  }
                  Update: {
                    "applied_at"?: string | null,"campaign_id"?: string | null,"cap_amount"?: number,"cash_amount"?: number,"clout_amount"?: number,"clout_cap"?: number,"created_at"?: string,"eligibility"?: NonNullable<Json>,"id"?: string,"idempotency_key"?: string,"issued_by"?: string,"item_id"?: string | null,"kind"?: string,"reason"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "grants_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"handles": {
                  Row: {
                    "claimed_at": string,"handle": string,"handle_key": string,"quarantine_until": string | null,"released_at": string | null,"retired_at": string | null,"retired_reason": string | null,"source": string,"user_id": string | null
                  }
                  Insert: {
                    "claimed_at"?: string,"handle": string,"handle_key": string,"quarantine_until"?: string | null,"released_at"?: string | null,"retired_at"?: string | null,"retired_reason"?: string | null,"source": string,"user_id"?: string | null
                  }
                  Update: {
                    "claimed_at"?: string,"handle"?: string,"handle_key"?: string,"quarantine_until"?: string | null,"released_at"?: string | null,"retired_at"?: string | null,"retired_reason"?: string | null,"source"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "handles_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"live_stats": {
                  Row: {
                    "key": string,"updated_at": string,"value": number
                  }
                  Insert: {
                    "key": string,"updated_at"?: string,"value"?: number
                  }
                  Update: {
                    "key"?: string,"updated_at"?: string,"value"?: number
                  }
                  Relationships: [
                    
                  ]
                },"mutes": {
                  Row: {
                    "created_at": string,"muted_id": string,"muter_id": string
                  }
                  Insert: {
                    "created_at"?: string,"muted_id": string,"muter_id": string
                  }
                  Update: {
                    "created_at"?: string,"muted_id"?: string,"muter_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "mutes_muted_id_fkey"
      columns: ["muted_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "mutes_muter_id_fkey"
      columns: ["muter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "attestation_recorded_at": string | null,"attested": boolean,"attested_at": string | null,"audio_choice": string | null,"audio_settings": Json | null,"audio_settings_updated_at": string | null,"avatar": NonNullable<Json>,"career_path": string | null,"consent_version": string | null,"consented_at": string | null,"created_at": string,"handle": string | null,"id": string,"public_level": string,"updated_at": string
                  }
                  Insert: {
                    "attestation_recorded_at"?: string | null,"attested"?: boolean,"attested_at"?: string | null,"audio_choice"?: string | null,"audio_settings"?: Json | null,"audio_settings_updated_at"?: string | null,"avatar"?: NonNullable<Json>,"career_path"?: string | null,"consent_version"?: string | null,"consented_at"?: string | null,"created_at"?: string,"handle"?: string | null,"id": string,"public_level"?: string,"updated_at"?: string
                  }
                  Update: {
                    "attestation_recorded_at"?: string | null,"attested"?: boolean,"attested_at"?: string | null,"audio_choice"?: string | null,"audio_settings"?: Json | null,"audio_settings_updated_at"?: string | null,"avatar"?: NonNullable<Json>,"career_path"?: string | null,"consent_version"?: string | null,"consented_at"?: string | null,"created_at"?: string,"handle"?: string | null,"id"?: string,"public_level"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"purchases": {
                  Row: {
                    "amount_cents": number,"created_at": string,"currency": string,"id": string,"item_id": string,"livemode": boolean,"paid_at": string | null,"price_tier": string,"refunded_at": string | null,"status": string,"stripe_checkout_session_id": string,"stripe_payment_intent_id": string | null,"updated_at": string,"user_id": string | null
                  }
                  Insert: {
                    "amount_cents": number,"created_at"?: string,"currency"?: string,"id"?: string,"item_id": string,"livemode"?: boolean,"paid_at"?: string | null,"price_tier": string,"refunded_at"?: string | null,"status"?: string,"stripe_checkout_session_id": string,"stripe_payment_intent_id"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Update: {
                    "amount_cents"?: number,"created_at"?: string,"currency"?: string,"id"?: string,"item_id"?: string,"livemode"?: boolean,"paid_at"?: string | null,"price_tier"?: string,"refunded_at"?: string | null,"status"?: string,"stripe_checkout_session_id"?: string,"stripe_payment_intent_id"?: string | null,"updated_at"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "purchases_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"referrals": {
                  Row: {
                    "created_at": string,"id": string,"invitee_id": string,"inviter_id": string,"qualified_at": string | null,"rewarded_at": string | null,"status": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"invitee_id": string,"inviter_id": string,"qualified_at"?: string | null,"rewarded_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"invitee_id"?: string,"inviter_id"?: string,"qualified_at"?: string | null,"rewarded_at"?: string | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "referrals_invitee_id_fkey"
      columns: ["invitee_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "referrals_inviter_id_fkey"
      columns: ["inviter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"roommates": {
                  Row: {
                    "accepted_at": string | null,"created_at": string,"ended_at": string | null,"home_id": string,"id": string,"invited_by": string,"status": string,"updated_at": string,"user_high": string,"user_low": string
                  }
                  Insert: {
                    "accepted_at"?: string | null,"created_at"?: string,"ended_at"?: string | null,"home_id": string,"id"?: string,"invited_by": string,"status"?: string,"updated_at"?: string,"user_high": string,"user_low": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"created_at"?: string,"ended_at"?: string | null,"home_id"?: string,"id"?: string,"invited_by"?: string,"status"?: string,"updated_at"?: string,"user_high"?: string,"user_low"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "roommates_user_high_fkey"
      columns: ["user_high"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "roommates_user_low_fkey"
      columns: ["user_low"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"saves": {
                  Row: {
                    "accepted_at": string | null,"burst_credit_minutes": number,"client_saved_at": string | null,"created_at": string,"data": NonNullable<Json>,"flag_reason": string | null,"flagged_at": string | null,"last_device_id": string | null,"pace_credit_cash": number,"pace_credit_clout": number,"rate_window_count": number,"rate_window_started_at": string | null,"revision": number,"save_version": number,"updated_at": string,"user_id": string
                  }
                  Insert: {
                    "accepted_at"?: string | null,"burst_credit_minutes"?: number,"client_saved_at"?: string | null,"created_at"?: string,"data": NonNullable<Json>,"flag_reason"?: string | null,"flagged_at"?: string | null,"last_device_id"?: string | null,"pace_credit_cash"?: number,"pace_credit_clout"?: number,"rate_window_count"?: number,"rate_window_started_at"?: string | null,"revision"?: number,"save_version": number,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"burst_credit_minutes"?: number,"client_saved_at"?: string | null,"created_at"?: string,"data"?: NonNullable<Json>,"flag_reason"?: string | null,"flagged_at"?: string | null,"last_device_id"?: string | null,"pace_credit_cash"?: number,"pace_credit_clout"?: number,"rate_window_count"?: number,"rate_window_started_at"?: string | null,"revision"?: number,"save_version"?: number,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "saves_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "acknowledge_notice":
{ Args: { "p_notice_id": string }; Returns: undefined
                           },
"assert_attested":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"attest_and_consent":
{ Args: { "p_adult": boolean,"p_attested_at": string,"p_audio_choice": string,"p_consent_version": string,"p_consented_at": string }; Returns: {
              "attestation_recorded_at": string | null,
"attested": boolean,
"attested_at": string | null,
"audio_choice": string | null,
"audio_settings": Json | null,
"audio_settings_updated_at": string | null,
"avatar": NonNullable<Json>,
"career_path": string | null,
"consent_version": string | null,
"consented_at": string | null,
"created_at": string,
"handle": string | null,
"id": string,
"public_level": string,
"updated_at": string
            }
                          SetofOptions: {
        from: "*"
        to: "profiles"
        isOneToOne: true
        isSetofReturn: false
      } },
"block_player":
{ Args: { "p_target": string }; Returns: {
              "friendship_ended": boolean,"roommate_ended": boolean,"undo_expires_at": string,"undo_id": string
            }[]
                           },
"check_handle":
{ Args: { "p_handle": string }; Returns: string
                           },
"commit_save":
{ Args: { "p_avatar": Json,"p_burst_credit_minutes": number,"p_career_path": string,"p_client_saved_at": string,"p_data": Json,"p_device_id": string,"p_expected_revision": number,"p_grants": Json,"p_history_keep": number,"p_ledger_keep": number,"p_max_per_minute": number,"p_min_interval_ms": number,"p_pace_credit_cash": number,"p_pace_credit_clout": number,"p_public_level": string,"p_same_run": boolean,"p_save_version": number,"p_user_id": string }; Returns: {
              "saved_at": string,"saved_revision": number
            }[]
                           },
"consume_save_override":
{ Args: { "p_max": number,"p_user_id": string }; Returns: undefined
                           },
"get_my_profile":
{ Args: Record<PropertyKey, never>; Returns: {
              "avatar": Json,"career_path": string,"free_handle_change": boolean,"handle": string,"handle_changes_left": number,"handle_generated": boolean,"next_handle_change_at": string,"public_level": string
            }[]
                           },
"get_public_profile":
{ Args: { "p_handle": string }; Returns: {
              "avatar": Json,"career_path": string,"handle": string,"public_level": string
            }[]
                           },
"get_public_profiles":
{ Args: { "p_ids": (string)[] }; Returns: {
              "avatar": Json,"career_path": string,"handle": string,"id": string,"public_level": string
            }[]
                           },
"list_my_blocks":
{ Args: Record<PropertyKey, never>; Returns: {
              "blocked_at": string,"handle": string,"player_id": string
            }[]
                           },
"list_my_mutes":
{ Args: Record<PropertyKey, never>; Returns: {
              "handle": string,"muted_at": string,"player_id": string
            }[]
                           },
"list_my_reports":
{ Args: Record<PropertyKey, never>; Returns: {
              "created_at": string,"kind": string,"reason": string,"report_id": string,"status": string,"target_handle": string
            }[]
                           },
"mod_ban":
{ Args: { "p_case": string,"p_correlation_id": string,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string,"p_reason": string }; Returns: Json
                           },
"mod_case":
{ Args: { "p_case": string,"p_moderator_id": string }; Returns: Json
                           },
"mod_dismiss":
{ Args: { "p_abusive": boolean,"p_case": string,"p_correlation_id": string,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string }; Returns: Json
                           },
"mod_queue":
{ Args: { "p_limit": number,"p_moderator_id": string }; Returns: Json
                           },
"mod_reset_handle":
{ Args: { "p_case": string,"p_correlation_id": string,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string,"p_reason": string }; Returns: Json
                           },
"mod_resolve_appeal":
{ Args: { "p_case": string,"p_correlation_id": string,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string,"p_overturn": boolean }; Returns: Json
                           },
"mod_restrict":
{ Args: { "p_case": string,"p_correlation_id": string,"p_days": number,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string,"p_reason": string }; Returns: Json
                           },
"mod_set_legal_hold":
{ Args: { "p_case": string,"p_correlation_id": string,"p_hold": boolean,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string }; Returns: Json
                           },
"mod_suspend":
{ Args: { "p_case": string,"p_correlation_id": string,"p_days": number,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string,"p_reason": string }; Returns: Json
                           },
"mod_warn":
{ Args: { "p_case": string,"p_correlation_id": string,"p_idempotency_key": string,"p_moderator_id": string,"p_note"?: string,"p_reason": string }; Returns: Json
                           },
"moderator_reset_handle":
{ Args: { "p_reason": string,"p_user_id": string }; Returns: string
                           },
"mute_player":
{ Args: { "p_target": string }; Returns: undefined
                           },
"quarantine_save":
{ Args: { "p_base_revision": number,"p_data": Json,"p_device_id": string,"p_findings": (string)[],"p_max_per_minute": number,"p_quarantine_keep": number,"p_save_version": number,"p_user_id": string }; Returns: undefined
                           },
"revision_at":
{ Args: { "p_revision": number,"p_user_id": string }; Returns: {
              "accepted_at": string,"base_actions": number,"base_minute": number,"base_prestige_count": number,"base_run": number,"burst_credit_minutes": number,"pace_credit_cash": number,"pace_credit_clout": number
            }[]
                           },
"save_at_revision":
{ Args: { "p_revision": number,"p_user_id": string }; Returns: {
              "accepted_at": string,"burst_credit_minutes": number,"data": Json,"pace_credit_cash": number,"pace_credit_clout": number,"revision": number,"save_version": number
            }[]
                           },
"send_friend_boost":
{ Args: { "p_to": string }; Returns: {
              "boost_id": number,"ny_day": string
            }[]
                           },
"set_audio_choice":
{ Args: { "p_choice": string }; Returns: undefined
                           },
"set_audio_settings":
{ Args: { "p_updated_at": string,"p_volumes": Json }; Returns: {
              "updated_at": string,"volumes": Json
            }[]
                           },
"set_handle":
{ Args: { "p_handle": string }; Returns: {
              "avatar": Json,"career_path": string,"free_handle_change": boolean,"handle": string,"handle_changes_left": number,"handle_generated": boolean,"next_handle_change_at": string,"public_level": string
            }[]
                           },
"submit_appeal":
{ Args: { "p_body": string,"p_notice_id": string }; Returns: {
              "appeal_id": string
            }[]
                           },
"submit_report":
{ Args: { "p_idempotency_key": string,"p_kind": string,"p_note": string,"p_reason": string,"p_target": string }; Returns: {
              "duplicate": boolean,"report_id": string
            }[]
                           },
"unblock_player":
{ Args: { "p_target": string,"p_undo"?: string }; Returns: {
              "friendship_restored": boolean,"roommate_restored": boolean,"unblocked": boolean
            }[]
                           },
"unmute_player":
{ Args: { "p_target": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
