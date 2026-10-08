/** Validated game content and world data. Import content from here, never the JSON directly. */
import audioJson from '@data/audio/manifest.json'
import boroughsJson from '@data/boroughs/boroughs.json'
import eventsJson from '@data/events/events.json'
import homesJson from '@data/homes/homes.json'
import boundsJson from '@data/geo/bounds.json'
import interiorsJson from '@data/homes/interiors.json'
import itemsJson from '@data/items/items.json'
import jobsJson from '@data/jobs/jobs.json'
import landmarksJson from '@data/landmarks/landmarks.json'
import premiumJson from '@data/premium/premium.json'
import venuesJson from '@data/venues/venues.json'
import zonesJson from '@data/zones/zones.derived.json'
import { parseDataFile } from './parse'
import {
  EventsFileSchema,
  HomesFileSchema,
  HomeInteriorsFileSchema,
  ItemsFileSchema,
  JobsFileSchema,
  LandmarksFileSchema,
  PremiumFileSchema,
  VenuesFileSchema,
} from './schemas/content'
import {
  AudioManifestSchema,
  BoroughsFileSchema,
  GeoBoundsSchema,
  ZonesFileSchema,
} from './schemas/world'

export const items = parseDataFile('items/items.json', ItemsFileSchema, itemsJson).items
export const premiumItems = parseDataFile(
  'premium/premium.json',
  PremiumFileSchema,
  premiumJson,
).items
export const events = parseDataFile('events/events.json', EventsFileSchema, eventsJson).events
export const jobs = parseDataFile('jobs/jobs.json', JobsFileSchema, jobsJson).jobs
export const venues = parseDataFile('venues/venues.json', VenuesFileSchema, venuesJson).venues
/** Where each home sits on the map (S05). */
export const homes = parseDataFile('homes/homes.json', HomesFileSchema, homesJson).homes
export const landmarks = parseDataFile(
  'landmarks/landmarks.json',
  LandmarksFileSchema,
  landmarksJson,
).landmarks
/** Each home's interior: room, window, door, camera, avatar anchor and decor slots (S16). */
export const homeInteriors = parseDataFile(
  'homes/interiors.json',
  HomeInteriorsFileSchema,
  interiorsJson,
).homes
export const geoBounds = parseDataFile('geo/bounds.json', GeoBoundsSchema, boundsJson)
export const zones = parseDataFile('zones/zones.derived.json', ZonesFileSchema, zonesJson).zones
export const audioManifest = parseDataFile('audio/manifest.json', AudioManifestSchema, audioJson)
export const boroughs = parseDataFile(
  'boroughs/boroughs.json',
  BoroughsFileSchema,
  boroughsJson,
).boroughs
