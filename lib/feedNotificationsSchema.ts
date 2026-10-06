import type Database from "better-sqlite3";
export function installFeedNotifications(db:Database.Database) {
 db.exec(`CREATE TABLE IF NOT EXISTS feed_notification_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,dnd INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT);
 CREATE TABLE IF NOT EXISTS feed_notification_devices(installation_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,grant_id TEXT NOT NULL,token TEXT NOT NULL,environment TEXT NOT NULL,topic TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL,updated_at TEXT NOT NULL,UNIQUE(environment,token));
 CREATE TABLE IF NOT EXISTS feed_notifications(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,group_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,UNIQUE(user_id,post_id));
 CREATE INDEX IF NOT EXISTS feed_notifications_owner ON feed_notifications(user_id,seq DESC);
 CREATE TABLE IF NOT EXISTS feed_notification_outbox(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES feed_notifications(id) ON DELETE CASCADE,installation_id TEXT NOT NULL REFERENCES feed_notification_devices(installation_id) ON DELETE CASCADE,device_revision INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT,reason TEXT,UNIQUE(notification_id,installation_id));
 CREATE INDEX IF NOT EXISTS feed_notification_queue ON feed_notification_outbox(state,created_at);
 CREATE TABLE IF NOT EXISTS feed_publication_receipts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,publication_id TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(user_id,publication_id));
 CREATE TRIGGER IF NOT EXISTS feed_news_notification AFTER INSERT ON feed_posts WHEN NEW.kind='news' AND NEW.hidden=0 BEGIN
 INSERT OR IGNORE INTO feed_notifications(id,user_id,post_id,group_id,title,created_at) VALUES('fn-'||substr(NEW.id,4),NEW.user_id,NEW.id,NEW.group_id,COALESCE(json_extract(NEW.payload,'$.title'),'新动态'),NEW.created_at);
 END;`);
}
