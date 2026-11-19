import type { Booking, Equipment, PersonSnapshot, User } from "../types";

export function person(user: User): PersonSnapshot {
  return { id: user._id, name: user.name, email: user.email, image: user.image ?? null };
}

export function userDto(user: User) {
  return { ...person(user), role: user.role, status: user.status ?? "active", phone: user.phone ?? "", address: user.address ?? "", createdAt: new Date(user.createdAt).toISOString() };
}

export function equipmentDto(equipment: Equipment, availableQuantity: number, owner?: User | null) {
  const { _id, inventoryRevision: _revision, deletedAt: _deleted, ...fields } = equipment;
  return { ...fields, id: _id, availableQuantity: Math.max(0, availableQuantity), owner: owner ? person(owner) : null, createdAt: new Date(equipment.createdAt).toISOString(), updatedAt: new Date(equipment.updatedAt).toISOString() };
}

export function bookingDto(booking: Booking) {
  const { _id, ...fields } = booking;
  return { ...fields, id: _id, createdAt: new Date(booking.createdAt).toISOString(), updatedAt: new Date(booking.updatedAt).toISOString() };
}

export function paginated<T>(items: T[], page: number, limit: number, total: number) {
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}
