from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from pwdlib import PasswordHash
from pwdlib.hashers.bcrypt import BcryptHasher
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.core.config import get_settings
from app.core.supabase import get_supabase

settings = get_settings()

# Use bcrypt explicitly to match the installed pwdlib extra and existing hashes.
password_hash = PasswordHash((BcryptHasher(),))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ---------------------------------------------------------------------------
# Password utilities
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    """Hash a plain-text password."""
    return password_hash.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain-text password against its hash."""
    return password_hash.verify(plain_password, hashed_password)


# ---------------------------------------------------------------------------
# JWT utilities
# ---------------------------------------------------------------------------

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a signed JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.jwt_access_token_expire_minutes)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """Decode and validate a JWT access token."""
    try:
        payload = jwt.decode(
            token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm]
        )
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ---------------------------------------------------------------------------
# Current-user dependency
# ---------------------------------------------------------------------------

def get_current_admin(
    token: str = Depends(oauth2_scheme),
    db=Depends(get_supabase),
):
    """Dependency that extracts and validates the current admin from the JWT."""
    payload = decode_access_token(token)
    if payload.get("account_type", "admin") != "admin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Administrator credentials are required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    admin_public_id: str = payload.get("sub")
    if admin_public_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    result = (
        db.table("admin")
        .select("*")
        .eq("public_id", admin_public_id)
        .eq("is_active", True)
        .execute()
    )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin not found or inactive",
        )

    return result.data[0]


def get_current_faculty(
    token: str = Depends(oauth2_scheme),
    db=Depends(get_supabase),
):
    """Dependency that validates an active faculty account token."""
    payload = decode_access_token(token)
    if payload.get("account_type") != "faculty":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Faculty credentials are required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    faculty_public_id = payload.get("sub")
    if not faculty_public_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    result = (
        db.table("faculty")
        .select("*")
        .eq("public_id", faculty_public_id)
        .eq("is_active", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Faculty account not found or inactive",
        )
    return result.data[0]


def get_current_student(
    token: str = Depends(oauth2_scheme),
    db=Depends(get_supabase),
):
    """Dependency that validates an active student account token."""
    payload = decode_access_token(token)
    if payload.get("account_type") != "student":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Student credentials are required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    student_public_id = payload.get("sub")
    if not student_public_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )

    result = (
        db.table("student")
        .select("*")
        .eq("public_id", student_public_id)
        .eq("is_active", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Student account not found or inactive",
        )
    return result.data[0]


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db=Depends(get_supabase),
):
    """Resolve an authenticated administrator or faculty member."""
    payload = decode_access_token(token)
    account_type = payload.get("account_type", "admin")
    public_id = payload.get("sub")
    if not public_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        )
    if account_type == "admin":
        table = "admin"
    elif account_type == "faculty":
        table = "faculty"
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid account type",
        )

    result = (
        db.table(table)
        .select("*")
        .eq("public_id", public_id)
        .eq("is_active", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account not found or inactive",
        )
    return {"account_type": account_type, "account": result.data[0]}


def get_current_super_admin(
    current_admin: dict = Depends(get_current_admin),
):
    """Require the authenticated administrator to have the super_admin role."""
    if current_admin.get("role") != "super_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Super admin privileges are required",
        )

    return current_admin


def get_current_department_head(
    current_faculty: dict = Depends(get_current_faculty),
):
    """Require the authenticated faculty member to be the department head."""
    if current_faculty.get("role") != "department_head":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Department head privileges are required",
        )
    return current_faculty
