import { Phase8AdminOperation, Phase8AdminCapabilities, adminDenied, adminOwnerError, adminPick, adminResult,
  type Phase8AdminAccess, type Phase8AdminAction, type Phase8AdminDependencies
} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { UserAdministrationService, type CreateUserInput, type UpdateUserAccessInput } from '../application/user-administration.service';

/** Real Users owner, with exact-operation resource proofs for delegated writes. No bearer forwarding. */
export class B2bPhase8IdentityAdmin {
  constructor(private readonly deps: Phase8AdminDependencies, private readonly owner?: UserAdministrationService,
    private readonly capabilities?: Phase8AdminCapabilities) {}
  async execute(access: Phase8AdminAccess, action: Phase8AdminAction, input: unknown) {
    let op: Phase8AdminOperation | undefined, handle: object | undefined;
    try {
      if (!['USERS_LIST','USERS_CREATE','USERS_UPDATE','ROLES_LIST','ROLES_UPDATE'].includes(action))
        return adminDenied(400,'INVALID_ADMIN_ACTION');
      op = await Phase8AdminOperation.open(this.deps,access,action,input);
      if (!this.owner) return adminDenied(503,'ADMIN_OWNER_UNAVAILABLE');
      if ((action === 'USERS_CREATE' || action === 'USERS_UPDATE') && !this.capabilities) return adminDenied(503,'ADMIN_USER_RESOURCE_RESOLVER_REQUIRED');
      const {id,payload} = op.input, actor = await op.revalidate();
      if (['USERS_LIST','ROLES_LIST'].includes(action) && (id !== undefined || Object.keys(payload).length)) return adminDenied(400,'INVALID_ADMIN_PAYLOAD');
      let data: unknown;
      switch (action) {
        case 'USERS_LIST': data = (await this.owner.listUsers(actor)).map(v=>({...adminPick(v,
          ['id','username','fullName','active','lastLoginAt','branchIds','emissionPointIds','series','editable']),
          roles:v.roles.map(r=>adminPick(r,['code','name']))})); break;
        case 'ROLES_LIST': data = (await this.owner.listRoles(actor)).map(v=>adminPick(v,
          ['id','code','name','description','permissions','editable','assignable'])); break;
        case 'USERS_CREATE':
          if (id !== undefined || Object.keys(payload).some(k=>!['username','fullName','password','roles','branchIds','emissionPointIds','series'].includes(k)))
            return adminDenied(400,'INVALID_ADMIN_PAYLOAD');
          handle = this.capabilities!.open(op);
          data = adminPick(await this.owner.create(payload as unknown as CreateUserInput,actor,handle),
            ['id','username','fullName','active','lastLoginAt','roles','branchIds','emissionPointIds','series']); break;
        case 'USERS_UPDATE':
          if (!id) return adminDenied(400,'ADMIN_TARGET_REQUIRED');
          handle = this.capabilities!.open(op);
          data = adminPick(await this.owner.updateAccess(id,payload as UpdateUserAccessInput,actor,handle),
            ['id','username','fullName','active','lastLoginAt','roles','branchIds','emissionPointIds','series']); break;
        case 'ROLES_UPDATE':
          if (!id) return adminDenied(400,'ADMIN_TARGET_REQUIRED');
          data = adminPick(await this.owner.updateRole(id,payload,actor),['code','permissions','affectedUsers']); break;
        default: return adminDenied(400,'INVALID_ADMIN_ACTION');
      }
      await op.revalidate(); return adminResult(data);
    } catch (error) { throw adminOwnerError(error); }
    finally { if (handle) this.capabilities!.revoke(handle); op?.close(); }
  }
}

