# AWS OIDC Reference (annotated, not executed)

This repo never touches a real AWS account — no personal account exists, and
every cloud provider requires a card even on free tier. This file maps the
Vault federation this repo actually runs (see `.github/workflows/ci.yml`,
`deploy` job) onto the equivalent AWS IAM configuration, so the concepts
transfer directly if a real AWS account exists later.

## What this repo actually proved, in Vault terms

- Trusting the issuer: `vault write auth/jwt/config oidc_discovery_url="https://token.actions.githubusercontent.com"`
- Restricting who can authenticate: `bound_claims={"repository": "Husnain062/ci-cd-learning-lab"}`
- The real GitHub OIDC claims observed from the `inspect-oidc` job include:
  - `repository: "Husnain062/ci-cd-learning-lab"`
  - `sub: "repo:Husnain062/ci-cd-learning-lab:pull_request"` (from the pull-request-triggered deploy run)

This repo chose to bind on the `repository` claim, trusting any workflow run in this repository regardless of branch or trigger. A stricter version would additionally restrict `sub` to `repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main` for a push-to-main-only trust boundary — that pattern is shown as the AWS equivalent below (just update the condition to match your desired strictness).

## The equivalent AWS configuration

### 1. Trust GitHub's signing keys (the OIDC provider)

```json
{
  "Url": "https://token.actions.githubusercontent.com",
  "ClientIDList": ["sts.amazonaws.com"],
  "ThumbprintList": ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}
```
Equivalent AWS CLI command:
```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```
This is the AWS-side equivalent of Vault's `auth/jwt/config` step above —
both are "go fetch GitHub's public signing keys and trust tokens signed
by them."

### 2. Restrict who can assume the role (the trust policy condition)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:repository": "Husnain062/ci-cd-learning-lab",
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```
This `Condition` block is the direct AWS equivalent of Vault's
`bound_claims` on the role — both check the same `repository` claim value
observed above, just expressed as a `StringEquals` condition instead of a
Vault role field.

**Note:** To make this stricter (push-to-main-only), add an additional condition:
```json
"token.actions.githubusercontent.com:sub": "repo:Husnain062/ci-cd-learning-lab:ref:refs/heads/main"
```
This is the AWS IAM equivalent of the sub-restricted binding pattern mentioned above.

### 3. Follow-up path

If a personal AWS account gets created later, this file becomes the exact
commands to run:
```bash
aws iam create-role \
  --role-name ci-cd-learning-lab-deploy \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name ci-cd-learning-lab-deploy \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```
No redesign needed — same OIDC claim mechanics this repo already proved
against Vault, just pointed at AWS IAM instead.
