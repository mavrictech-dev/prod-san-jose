[CmdletBinding()]
param([string[]]$Names=@('private-db','core','edge','egress','host-access'))
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($Names.Count -lt 1 -or $Names.Count -gt 8 -or @($Names|Where-Object {$_ -notmatch '^[a-z][a-z0-9-]{0,40}$'}).Count){throw 'Invalid network names.'}
function Range([string]$Cidr){
 if($Cidr -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$'){return}
 $parts=$Cidr.Split('/');$address=[Net.IPAddress]::Parse($parts[0]).GetAddressBytes();$bits=[int]$parts[1]
 if($bits -eq 0){return};if($bits -gt 32){throw 'Invalid IPv4 prefix.'}
 $n=[uint64]$address[0]*16777216+[uint64]$address[1]*65536+[uint64]$address[2]*256+[uint64]$address[3]
 $size=[uint64][Math]::Pow(2,32-$bits);$start=[uint64]([Math]::Floor($n/$size)*$size)
 return @{first=$start;last=$start+$size-1}
}
# Read topology only. Never change daemon pools, existing networks or host routes.
$used=@(Get-NetRoute -AddressFamily IPv4 -ErrorAction Stop|ForEach-Object {Range $_.DestinationPrefix})
$ids=@(& docker --context desktop-linux network ls --quiet)
if($LASTEXITCODE -ne 0){throw 'Cannot inspect local Docker networks.'}
if($ids.Count){
 $raw=& docker --context desktop-linux network inspect @ids
 if($LASTEXITCODE -ne 0){throw 'Cannot inspect local Docker IPAM.'}
 foreach($network in ($raw -join "`n"|ConvertFrom-Json)){foreach($entry in @($network.IPAM.Config)){if($entry -and $entry.Subnet){$used+=@(Range $entry.Subnet)}}}
}
foreach($second in @(253,254,252)){
 foreach($third in 200..254){
  $candidate=Range ('10.'+$second+'.'+$third+'.0/24')
  if(@($used|Where-Object {$_ -and $_.first -le $candidate.last -and $_.last -ge $candidate.first}).Count){continue}
  $networks=@{};$offset=0
  foreach($name in $Names){$networks[$name]=@{ipam=@{config=@(@{subnet=('10.'+$second+'.'+$third+'.'+$offset+'/27')})}};$offset+=32}
  @{networks=$networks}|ConvertTo-Json -Depth 8
  exit 0
 }
}
throw 'No reviewed private subnet available. Ask IT for a range; existing networks were not changed.'
