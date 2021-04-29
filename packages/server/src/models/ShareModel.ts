import { ModelType } from '@joplin/lib/BaseModel';
import { resourceBlobPath } from '../apps/joplin/joplinUtils';
import { Change, ChangeType, isUniqueConstraintError, Item, Share, ShareType, User, Uuid } from '../db';
import { unique } from '../utils/array';
import { ErrorBadRequest, ErrorForbidden, ErrorNotFound } from '../utils/errors';
import { setQueryParameters } from '../utils/urlUtils';
import BaseModel, { AclAction, DeleteOptions, ValidateOptions } from './BaseModel';
import { ChangePreviousItem } from './ChangeModel';
import { SharedRootInfo } from './ItemModel';

export default class ShareModel extends BaseModel<Share> {

	public get tableName(): string {
		return 'shares';
	}

	public async checkIfAllowed(user: User, action: AclAction, resource: Share = null): Promise<void> {
		if (action === AclAction.Create) {
			if (!await this.models().item().userHasItem(user.id, resource.item_id)) throw new ErrorForbidden('cannot share an item not owned by the user');
		}

		if (action === AclAction.Read) {
			if (user.id !== resource.owner_id) throw new ErrorForbidden('no access to this share');
		}
	}

	protected objectToApiOutput(object: Share): Share {
		const output: Share = {};

		if (object.id) output.id = object.id;
		if (object.type) output.type = object.type;
		if (object.folder_id) output.folder_id = object.folder_id;
		if (object.note_id) output.note_id = object.note_id;

		return output;
	}

	protected async validate(share: Share, options: ValidateOptions = {}): Promise<Share> {
		if ('type' in share && ![ShareType.Link, ShareType.App, ShareType.JoplinRootFolder].includes(share.type)) throw new ErrorBadRequest(`Invalid share type: ${share.type}`);
		if (share.type !== ShareType.Link && await this.itemIsShared(share.type, share.item_id)) throw new ErrorBadRequest('A shared item cannot be shared again');

		const item = await this.models().item().load(share.item_id);
		if (!item) throw new ErrorNotFound(`Could not find item: ${share.item_id}`);

		return super.validate(share, options);
	}

	public async createShare(userId: Uuid, shareType: ShareType, itemId: Uuid): Promise<Share> {
		const toSave: Share = {
			type: shareType,
			item_id: itemId,
			owner_id: userId,
		};

		return this.save(toSave);
	}

	public async itemShare(shareType: ShareType, itemId: string): Promise<Share> {
		return this
			.db(this.tableName)
			.select(this.defaultFields)
			.where('item_id', '=', itemId)
			.where('type', '=', shareType)
			.first();
	}

	public async itemIsShared(shareType: ShareType, itemId: string): Promise<boolean> {
		const r = await this.itemShare(shareType, itemId);
		return !!r;
	}

	public shareUrl(id: Uuid, query: any = null): string {
		return setQueryParameters(`${this.baseUrl}/shares/${id}`, query);
	}

	public async byItemIds(itemIds: Uuid[]): Promise<Share[]> {
		return this.db(this.tableName).select(this.defaultFields).whereIn('item_id', itemIds);
	}

	public async byUserAndItemId(userId: Uuid, itemId: Uuid): Promise<Share> {
		return this.db(this.tableName).select(this.defaultFields)
			.where('owner_id', '=', userId)
			.where('item_id', '=', itemId)
			.first();
	}

	public async sharesByUser(userId: Uuid, type: ShareType = null): Promise<Share[]> {
		const query = this.db(this.tableName)
			.select(this.defaultFields)
			.where('owner_id', '=', userId);

		if (type) void query.andWhere('type', '=', type);

		return query;
	}

	// Returns all user IDs concerned by the share. That includes all the users
	// the folder has been shared with, as well as the folder owner.
	private async allShareUserIds(share: Share) {
		const shareUsers = await this.models().shareUser().byShareId(share.id);
		const userIds = shareUsers.map(su => su.user_id);
		userIds.push(share.owner_id);
		return userIds;
	}

	public async updateSharedItems() {
		enum ResourceChangeAction {
			Added = 1,
			Removed = 2,
		}

		interface ResourceChange {
			resourceIds: string[];
			share: Share;
			change: Change;
			action: ResourceChangeAction;
		}

		let resourceChanges: ResourceChange[] = [];

		const handleAddedToSharedFolder = async (item: Item, shareInfo: SharedRootInfo) => {
			const userIds = await this.allShareUserIds(shareInfo.share);

			for (const userId of userIds) {
				try {
					await this.models().userItem().add(userId, item.id);
				} catch (error) {
					if (isUniqueConstraintError(error)) {
						// Ignore - it means this user already has this item
					} else {
						throw error;
					}
				}
			}
		};

		const handleRemovedFromSharedFolder = async (change: Change, item: Item, shareInfo: SharedRootInfo) => {
			// This is called when a note parent ID changes and is moved out of
			// the shared folder. In that case, we need to unshare the item from
			// all users, except the one who did the action.
			//
			// - User 1 shares a folder with user 2
			// - User 2 moves a note out of the shared folder
			// - User 1 should no longer see the note. User 2 still sees it
			//   since they have moved it to one of their own folders.

			const userIds = await this.allShareUserIds(shareInfo.share);

			for (const userId of userIds) {
				if (change.user_id !== userId) {
					await this.models().userItem().remove(userId, item.id);
				}
			}
		};

		const handleResourceSharing = async (change: Change, previousItem: ChangePreviousItem, item: Item, previousShareInfo: SharedRootInfo, currentShareInfo: SharedRootInfo) => {
			// Not a note - we can exit
			if (item.jop_type !== ModelType.Note) return;

			// Item was not in a shared folder and is still not in one - nothing to do
			if (!previousShareInfo && !currentShareInfo) return;

			// if (currentShareInfo && !resourceChanges[currentShareInfo.share.id]) {
			// 	resourceChanges[currentShareInfo.share.id] = {
			// 		share: currentShareInfo.share,
			// 		added: [],
			// 		removed: [],
			// 	};
			// }

			// if (previousShareInfo && !resourceChanges[previousShareInfo.share.id]) {
			// 	resourceChanges[previousShareInfo.share.id] = {
			// 		share: previousShareInfo.share,
			// 		added: [],
			// 		removed: [],
			// 	};
			// }

			// Item was moved out of a shared folder to a non-shared folder - unshare all resources
			if (previousShareInfo && !currentShareInfo) {
				// resourceChanges[previousShareInfo.share.id].removed = resourceChanges[previousShareInfo.share.id].removed.concat(previousItem.jop_resource_ids);
				resourceChanges.push({
					action: ResourceChangeAction.Removed,
					change,
					share: previousShareInfo.share,
					resourceIds: await this.models().itemResource().byItemId(item.id),
				});
				return;
			}

			// Item was moved from a non-shared folder to a shared one - share all resources
			if (!previousShareInfo && currentShareInfo) {
				resourceChanges.push({
					action: ResourceChangeAction.Added,
					change,
					share: currentShareInfo.share,
					resourceIds: await this.models().itemResource().byItemId(item.id),
				});
				// resourceChanges[currentShareInfo.share.id].added = resourceChanges[currentShareInfo.share.id].added.concat(await this.models().itemResource().byItemId(item.id));
				return;
			}

			// Note either stayed in the same shared folder, or moved to another
			// shared folder. In that case, we check the note content before and
			// after and see if resources have been added or removed from it,
			// then we share/unshare resources based on this.

			const previousResourceIds = previousItem ? previousItem.jop_resource_ids : [];
			const currentResourceIds = await this.models().itemResource().byItemId(item.id);
			for (const resourceId of previousResourceIds) {
				if (!currentResourceIds.includes(resourceId)) {
					resourceChanges.push({
						action: ResourceChangeAction.Removed,
						change,
						share: currentShareInfo.share,
						resourceIds: [resourceId],
					});
				}// resourceChanges[currentShareInfo.share.id].removed.push(resourceId);
			}

			for (const resourceId of currentResourceIds) {
				if (!previousResourceIds.includes(resourceId)) {
					resourceChanges.push({
						action: ResourceChangeAction.Added,
						change,
						share: currentShareInfo.share,
						resourceIds: [resourceId],
					});
					// resourceChanges[currentShareInfo.share.id].added.push(resourceId);
				}
			}
		};

		const handleCreatedItem = async (_change: Change, item: Item) => {
			if (!item.jop_parent_id) return;
			const shareInfo = await this.models().item().joplinItemSharedRootInfo(item.jop_parent_id);

			if (!shareInfo) return;
			await handleAddedToSharedFolder(item, shareInfo);
		};

		const handleUpdatedItem = async (change: Change, item: Item) => {
			if (![ModelType.Note, ModelType.Folder].includes(item.jop_type)) return;

			const previousItem = this.models().change().unserializePreviousItem(change.previous_item);

			const previousShareInfo = previousItem?.jop_parent_id ? await this.models().item().joplinItemSharedRootInfo(previousItem.jop_parent_id) : null;
			const currentShareInfo = item.jop_parent_id ? await this.models().item().joplinItemSharedRootInfo(item.jop_parent_id) : null;

			await handleResourceSharing(change, previousItem, item, previousShareInfo, currentShareInfo);

			// Item was not in a shared folder and is still not in one
			if (!previousShareInfo && !currentShareInfo) return;

			// Item was in a shared folder and is still in the same shared folder
			if (previousShareInfo && currentShareInfo && previousShareInfo.item.jop_parent_id === currentShareInfo.item.jop_parent_id) return;

			// Item was not previously in a shared folder but has been moved to one
			if (!previousShareInfo && currentShareInfo) {
				await handleAddedToSharedFolder(item, currentShareInfo);
				return;
			}

			// Item was in a shared folder and is no longer in one
			if (previousShareInfo && !currentShareInfo) {
				await handleRemovedFromSharedFolder(change, item, previousShareInfo);
				return;
			}

			// Item was in a shared folder and has been moved to a different shared folder
			if (previousShareInfo && currentShareInfo && previousShareInfo.item.jop_parent_id !== currentShareInfo.item.jop_parent_id) {
				await handleRemovedFromSharedFolder(change, item, previousShareInfo);
				await handleAddedToSharedFolder(item, currentShareInfo);
				return;
			}

			// Sanity check - because normally all cases are covered above
			throw new Error('Unreachable');
		};

		while (true) {
			const latestProcessedChange = await this.models().keyValue().value<string>('ShareService::latestProcessedChange');

			const changes = await this.models().change().allFromId(latestProcessedChange || '');
			if (!changes.length) break;

			const items = await this.models().item().loadByIds(changes.map(c => c.item_id));

			await this.withTransaction(async () => {
				for (const change of changes) {
					if (change.type === ChangeType.Create) {
						await handleCreatedItem(change, items.find(i => i.id === change.item_id));
					}

					if (change.type === ChangeType.Update) {
						await handleUpdatedItem(change, items.find(i => i.id === change.item_id));
					}

					// We don't need to handle ChangeType.Delete because when an
					// item is deleted, all its associated userItems are deleted
					// too.
				}

				for (const rc of resourceChanges) {
					const shareUsers = await this.models().shareUser().byShareId(rc.share.id);
					const doShare = rc.action === ResourceChangeAction.Added;

					for (const shareUser of shareUsers) {
						await this.updateResourceShareStatus(doShare, rc.share.id, rc.share.owner_id, shareUser.user_id, rc.resourceIds);
					}
				}

				resourceChanges = [];

				await this.models().keyValue().setValue('ShareService::latestProcessedChange', changes[changes.length - 1].id);
			});
		}
	}

	public async updateResourceShareStatus(doShare: boolean, shareId: Uuid, fromUserId: Uuid, toUserId: Uuid, resourceIds: string[]) {
		const resourceItems = await this.models().item().loadByJopIds(fromUserId, resourceIds);
		const resourceBlobNames = resourceIds.map(id => resourceBlobPath(id));
		const resourceBlobItems = await this.models().item().loadByNames(fromUserId, resourceBlobNames);

		for (const resourceItem of resourceItems) {
			if (doShare) {
				await this.models().userItem().add(toUserId, resourceItem.id, shareId);
			} else {
				await this.models().userItem().remove(toUserId, resourceItem.id);
			}
		}

		for (const resourceBlobItem of resourceBlobItems) {
			if (doShare) {
				await this.models().userItem().add(toUserId, resourceBlobItem.id, shareId);
			} else {
				await this.models().userItem().remove(toUserId, resourceBlobItem.id);
			}
		}
	}

	public async shareFolder(owner: User, folderId: string): Promise<Share> {
		const folderItem = await this.models().item().loadByJopId(owner.id, folderId);
		if (!folderItem) throw new ErrorNotFound(`No such folder: ${folderId}`);

		const share = await this.models().share().byUserAndItemId(owner.id, folderItem.id);
		if (share) return share;

		const shareToSave = {
			type: ShareType.JoplinRootFolder,
			item_id: folderItem.id,
			owner_id: owner.id,
			folder_id: folderId,
		};

		await this.checkIfAllowed(owner, AclAction.Create, shareToSave);

		return super.save(shareToSave);
	}

	public async shareNote(owner: User, noteId: string): Promise<Share> {
		const noteItem = await this.models().item().loadByJopId(owner.id, noteId);
		if (!noteItem) throw new ErrorNotFound(`No such note: ${noteId}`);

		const shareToSave = {
			type: ShareType.Link,
			item_id: noteItem.id,
			owner_id: owner.id,
			note_id: noteId,
		};

		await this.checkIfAllowed(owner, AclAction.Create, shareToSave);

		return this.save(shareToSave);
	}

	public async delete(id: string | string[], options: DeleteOptions = {}): Promise<void> {
		const ids = typeof id === 'string' ? [id] : id;
		const shares = await this.loadByIds(ids);

		await this.withTransaction(async () => {
			for (const share of shares) {
				await this.models().shareUser().deleteByShare(share);
				await this.models().userItem().deleteByShareId(share.id);
				await super.delete(share.id, options);
			}
		}, 'ShareModel::delete');
	}

}
