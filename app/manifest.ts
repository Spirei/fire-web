import type {MetadataRoute} from 'next';
import {platformJson} from '@/lib/platformTransport';
export const dynamic='force-dynamic';
export default async function manifest():Promise<MetadataRoute.Manifest>{return platformJson('/manifest.webmanifest');}
