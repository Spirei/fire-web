export type MigrationSourceConfig = {
  kind?: "postgresql"; host: string; port: number; database: string; username: string;
  schema_name: string; ssl_mode?: "disable" | "require" | "verify-ca" | "verify-full";
};
export type MigrationConnectionCheck = {
  state: "connected" | "failed"; observed_at: string; response_ms?: number; revision?: string;
  database?: string; schema?: string; server_version?: string; table_count?: number;
  read_only?: boolean; persistent_identity_verified?: boolean; identity_fingerprint?: string;
};
export type MigrationConnectionData = {
  source: { revision: string; config: MigrationSourceConfig; password_configured: boolean; updated_at: string } | null;
  target: { config: MigrationSourceConfig; password_configured: boolean; instance_id: string; environment: string; managed_by: "environment" };
  checks: { source: MigrationConnectionCheck | null; target: MigrationConnectionCheck | null };
};
export type MigrationPreparationTask = {
  id:string; request_id:string; kind:'database.migration.prepare';
  source_revision?:string|null;created_at?:string;
  status:'queued'|'running'|'cancel_requested'|'cancelled'|'succeeded'|'failed'; error_code?:string|null;
  result?:{phase:string;business_written:boolean;cutover_ready:boolean;message?:string;source_revision?:string;
    progress?:{phase:string;processed:number;total:number|null;unit:string};
    source?:{tables:number;rows:number;bytes:number;archive_integrity_verified:boolean;restore_verified:boolean};
    target?:{tables:number;rows:number;bytes:number;archive_integrity_verified:boolean;restore_verified:boolean};
  }|null;
  events?:{id:number;phase:string;created_at:string}[];
};
